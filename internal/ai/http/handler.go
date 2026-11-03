package aihttp

import (
	"io"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// HTTPDeps is the route surface. Access resolves the workspace member.
type HTTPDeps struct {
	Deps
	Access access.Resolver
}

// Register mounts /api/ai. Administrative price writes belong to admin/http.
func Register(router chi.Router, deps HTTPDeps) {
	h := httpHandler{deps: deps}
	router.Post("/api/ai/chat/completions", h.chat(aiclient.ChatCompletions))
	router.Post("/api/ai/v1/messages", h.chat(aiclient.AnthropicMessages))
	router.Post("/api/ai/responses", h.chat(aiclient.Responses))
	router.Post("/api/ai/image-sets", h.imageSetPost)
	router.Get("/api/ai/image-sets", h.imageSetLookup)
	router.Get("/api/ai/image-sets/capability", h.imageSetCapability)
	router.Get("/api/ai/image-sets/{id}", h.imageSetGet)
	router.Post("/api/admin/ai/ocr-tests/{id}/upload", h.ocrTestUpload)
	router.Post("/api/admin/ai/ocr-tests/{id}/confirm", h.ocrTestConfirm)
	router.Post("/api/admin/ai/ocr-tests/{id}", h.ocrTestPost)
	router.Get("/api/admin/ai/ocr-tests/{id}", h.ocrTestGet)
	router.Post("/api/ai/ocr/uploads", h.ocrUpload)
	router.Post("/api/ai/ocr/uploads/confirm", h.ocrUploadConfirm)
	router.Post("/api/ai/ocr/completions", h.ocrPost)
	router.Get("/api/ai/ocr/completions", h.ocrGet)
	router.Get("/api/ai/wallet", h.wallet)
	router.Get("/api/ai/logs", h.logs)
	router.Get("/api/ai/logs/stat", h.logStat)
	router.Get("/api/ai/logs/export", h.logExport)
	router.Get("/api/ai/usage", h.usage)
	router.Get("/api/ai/prices", h.prices)
}

type httpHandler struct{ deps HTTPDeps }

type rechargeOrderView struct {
	PublicID      string  `json:"public_id"`
	OperationID   string  `json:"operation_id"`
	AmountCents   int64   `json:"amount_cents"`
	TopupMicrofen int64   `json:"topup_microfen"`
	Currency      string  `json:"currency"`
	Provider      string  `json:"provider"`
	Status        string  `json:"status"`
	EntryState    string  `json:"entry_state"`
	CreatedAt     string  `json:"created_at"`
	PaidAt        *string `json:"paid_at,omitempty"`
	CanceledAt    *string `json:"canceled_at,omitempty"`
	QRCode        *string `json:"qr_code,omitempty"`
	PayURL        *string `json:"pay_url,omitempty"`
}

func (h httpHandler) chat(format aiclient.Format) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := member(w, h.deps.Access, r)
		if !ok {
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
		if err != nil {
			writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
			return
		}
		resp := Chat(withClientIP(r.Context(), remoteIP(r)), h.deps.Deps, format, principal.OrgID, principal.UserID, r.Header.Get("Idempotency-Key"), body)
		writeResp(w, resp)
	}
}

func (h httpHandler) wallet(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	if h.deps.Pool == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	tx, err := tenantx.BeginApp(r.Context(), h.deps.Pool.Begin, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer tx.Rollback(r.Context())
	if h.deps.Wallet.ViewTx == nil || h.deps.Wallet.RecentLedgerTx == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	view, err := h.deps.Wallet.ViewTx(r.Context(), tx, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	ledger, err := h.deps.Wallet.RecentLedgerTx(r.Context(), tx, principal.OrgID, 50)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	rows, err := tx.Query(r.Context(), `
		SELECT public_id, COALESCE(operation_id, ''), amount_cents, topup_microfen,
		       currency, provider, status, created_at, paid_at, canceled_at, qr_code, pay_url,
		       CASE WHEN status <> 'pending' THEN 'closed'
		            WHEN provider = 'manual' THEN 'manual'
		            WHEN qr_code IS NOT NULL OR pay_url IS NOT NULL THEN 'ready'
		            ELSE COALESCE(launch_state, 'entry_unknown') END
		  FROM payment_orders WHERE org_id = $1 AND product = 'wallet_topup'
		 ORDER BY id DESC LIMIT 50`, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	recharges := make([]rechargeOrderView, 0)
	for rows.Next() {
		var order rechargeOrderView
		var created time.Time
		var paid, canceled *time.Time
		if err := rows.Scan(&order.PublicID, &order.OperationID, &order.AmountCents, &order.TopupMicrofen,
			&order.Currency, &order.Provider, &order.Status, &created, &paid, &canceled, &order.QRCode, &order.PayURL, &order.EntryState); err != nil {
			rows.Close()
			writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
			return
		}
		order.CreatedAt = billing.RFC3339Millis(created)
		if paid != nil {
			value := billing.RFC3339Millis(*paid)
			order.PaidAt = &value
		}
		if canceled != nil {
			value := billing.RFC3339Millis(*canceled)
			order.CanceledAt = &value
		}
		recharges = append(recharges, order)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	entries := make([]map[string]any, 0, len(ledger))
	for _, row := range ledger {
		entries = append(entries, map[string]any{
			"entry_type": row.EntryType, "amount_microfen": row.AmountMicrofen,
			"balance_after_microfen": row.BalanceAfterMicrofen, "note": row.Note,
			"created_at": billing.RFC3339Millis(row.CreatedAt),
		})
	}
	jsonwire.Write(w, 200, map[string]any{
		"balance_microfen": view.BalanceMicrofen, "held_microfen": view.HeldMicrofen,
		"available_microfen": view.AvailableMicrofen, "spent_microfen": view.SpentMicrofen,
		"updated_at": billing.RFC3339Millis(view.UpdatedAt), "ledger": entries, "recharges": recharges,
	})
}

func (h httpHandler) usage(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	tx, err := tenantx.BeginApp(r.Context(), h.deps.Pool.Begin, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer tx.Rollback(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT public_id, model, status, prompt_tokens, cached_prompt_tokens, completion_tokens,
		       reasoning_completion_tokens, uncached_input_microfen, cached_input_microfen,
		       output_microfen, reasoning_microfen, total_microfen, charged_microfen, absorbed_microfen,
		       error_class
		  FROM ai_requests WHERE org_id = $1 ORDER BY id DESC LIMIT 100`, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer rows.Close()
	var list []map[string]any
	for rows.Next() {
		var item billingView
		if err := rows.Scan(&item.RequestID, &item.Model, &item.Status, &item.PromptTokens, &item.CachedPromptTokens,
			&item.CompletionTokens, &item.ReasoningCompletionTokens, &item.UncachedInput, &item.CachedInput,
			&item.Output, &item.Reasoning, &item.Total, &item.Charged, &item.Absorbed, &item.ErrorClass); err != nil {
			writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
			return
		}
		row := map[string]any{
			"request_id": item.RequestID, "model": item.Model, "status": item.Status,
			"total_microfen": item.Total, "charged_microfen": item.Charged, "absorbed_microfen": item.Absorbed,
			"error_class": item.ErrorClass,
		}
		list = append(list, row)
	}
	if list == nil {
		list = []map[string]any{}
	}
	jsonwire.Write(w, 200, map[string]any{"items": list, "total": len(list)})
}

func (h httpHandler) prices(w http.ResponseWriter, r *http.Request) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	if h.deps.Pool == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "模型价格不可用"))
		return
	}
	tx, err := tenantx.BeginApp(r.Context(), h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer tx.Rollback(r.Context())
	if h.deps.Wallet.CurrentAll == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	prices, err := h.deps.Wallet.CurrentAll(r.Context(), tx)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if prices == nil {
		prices = []billing.Price{}
	}
	models := []string{}
	preferred := ""
	if h.deps.OCR != nil && h.deps.OCR.Models != nil {
		offered, def, err := h.deps.OCR.Models(r.Context())
		if err == nil {
			priced := map[string]bool{}
			for _, p := range prices {
				priced[p.Model] = true
			}
			for _, model := range offered {
				if priced[model] {
					models = append(models, model)
					if model == def {
						preferred = model
					}
				}
			}
		}
	}
	jsonwire.Write(w, 200, map[string]any{"prices": prices, "ocr_models": models, "default_ocr_model": preferred})
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func member(w http.ResponseWriter, resolver access.Resolver, r *http.Request) (*access.Principal, bool) {
	principal, refusal, err := resolveAI(resolver, r)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return nil, false
	}
	if refusal != nil {
		code := "FORBIDDEN"
		if refusal.Status == http.StatusUnauthorized || refusal.Kind == access.RefusalUnauthenticated {
			code = "AUTH_REQUIRED"
		}
		writeResp(w, fail(refusal.Status, code, refusal.Message))
		return nil, false
	}
	if principal == nil {
		writeResp(w, fail(http.StatusUnauthorized, "AUTH_REQUIRED", access.MsgUnauthenticated))
		return nil, false
	}
	if status, message, ok := access.OrgMember(*principal); !ok {
		writeResp(w, fail(status, "FORBIDDEN", message))
		return nil, false
	}
	return principal, true
}

func resolveAI(resolver access.Resolver, r *http.Request) (*access.Principal, *access.Refusal, error) {
	if resolver == nil {
		return nil, nil, nil
	}
	return resolver.Resolve(r)
}

func writeResp(w http.ResponseWriter, resp Response) {
	if resp.RetryAfter != "" {
		w.Header().Set("Retry-After", resp.RetryAfter)
	}
	jsonwire.Write(w, resp.Status, resp.JSON)
}
