package aihttp

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// HTTPDeps is the route surface. Access resolves the workspace member.
type HTTPDeps struct {
	Deps
	Access access.Resolver
}

// Register mounts /api/ai and the price admin routes. It does not edit OpenAPI.
func Register(router chi.Router, deps HTTPDeps) {
	h := httpHandler{deps: deps}
	router.Post("/api/ai/chat/completions", h.chat)
	router.Post("/api/ai/ocr/completions", h.ocrPost)
	router.Get("/api/ai/ocr/completions", h.ocrGet)
	router.Get("/api/ai/wallet", h.wallet)
	router.Get("/api/ai/logs", h.logs)
	router.Get("/api/ai/logs/stat", h.logStat)
	router.Get("/api/ai/logs/export", h.logExport)
	router.Get("/api/ai/usage", h.usage)
	router.Get("/api/ai/prices", h.prices)
	router.Put("/api/admin/ai/prices", h.publish)
	router.Delete("/api/admin/ai/prices", h.unpublish)
}

type httpHandler struct{ deps HTTPDeps }

func (h httpHandler) chat(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
		return
	}
	resp := Chat(withClientIP(r.Context(), remoteIP(r)), h.deps.Deps, principal.OrgID, principal.UserID, r.Header.Get("Idempotency-Key"), body)
	writeResp(w, resp)
}

func (h httpHandler) ocrPost(w http.ResponseWriter, r *http.Request) {
	if _, ok := member(w, h.deps.Access, r); !ok {
		return
	}
	// Listing writeback and the OCR purchase body were not read. A successful
	// response would claim a listing change this process cannot persist.
	writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
}

func (h httpHandler) ocrGet(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	key, good := Key(r.Header.Get("Idempotency-Key"))
	if !good {
		writeResp(w, fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头"))
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
	var body []byte
	var status string
	err = tx.QueryRow(r.Context(), `
		SELECT status, response_body FROM ai_requests
		 WHERE org_id = $1 AND idempotency_key = $2 AND operation = 'ocr'
		 ORDER BY id DESC LIMIT 1`, principal.OrgID, key).Scan(&status, &body)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && len(body) == 0) {
		writeResp(w, fail(404, "NOT_FOUND", "请求不存在"))
		return
	}
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	writeJSON(w, 200, map[string]any{"completion": json.RawMessage(body), "status": status})
}

func (h httpHandler) wallet(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	tx, err := h.deps.Pool.Begin(r.Context())
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer tx.Rollback(r.Context())
	view, err := billing.ViewTx(r.Context(), tx, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	ledger, err := billing.RecentLedgerTx(r.Context(), tx, principal.OrgID, 50)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	_ = tx.Commit(r.Context())
	entries := make([]map[string]any, 0, len(ledger))
	for _, row := range ledger {
		entries = append(entries, map[string]any{
			"entry_type": row.EntryType, "amount_microfen": row.AmountMicrofen,
			"balance_after_microfen": row.BalanceAfterMicrofen, "note": row.Note,
			"created_at": billing.RFC3339Millis(row.CreatedAt),
		})
	}
	writeJSON(w, 200, map[string]any{
		"balance_microfen": view.BalanceMicrofen, "held_microfen": view.HeldMicrofen,
		"available_microfen": view.AvailableMicrofen, "spent_microfen": view.SpentMicrofen,
		"updated_at": billing.RFC3339Millis(view.UpdatedAt), "ledger": entries,
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
	writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
}

func (h httpHandler) prices(w http.ResponseWriter, r *http.Request) {
	if _, ok := member(w, h.deps.Access, r); !ok {
		return
	}
	prices, err := billing.CurrentAll(r.Context(), h.deps.Pool)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	writeJSON(w, 200, map[string]any{"prices": prices, "ocr_models": nil, "default_ocr_model": nil})
}

func (h httpHandler) publish(w http.ResponseWriter, r *http.Request) {
	principal, ok := superAdmin(w, h.deps.Access, r)
	if !ok {
		return
	}
	var body billing.PublishRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || !billing.ValidModel(body.Model) {
		writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
		return
	}
	if body.BillingMode == "" {
		body.BillingMode = billing.ModeToken
	}
	normalized, message, good := billing.Normalize(body.Model, body)
	if !good {
		writeResp(w, fail(400, "VALIDATION", message))
		return
	}
	price, err := billing.Publish(r.Context(), h.deps.Pool, principal.UserID, normalized)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	writeJSON(w, 200, map[string]any{"price": price, "ocr_models": nil, "default_ocr_model": nil})
}

func (h httpHandler) unpublish(w http.ResponseWriter, r *http.Request) {
	if _, ok := superAdmin(w, h.deps.Access, r); !ok {
		return
	}
	var body struct {
		Model string `json:"model"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || !billing.ValidModel(body.Model) {
		writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
		return
	}
	gone, err := billing.Unpublish(r.Context(), h.deps.Pool, body.Model)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if !gone {
		writeResp(w, fail(404, "NOT_FOUND", "模型价格不存在"))
		return
	}
	writeJSON(w, 200, map[string]any{"removed": true})
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

func superAdmin(w http.ResponseWriter, resolver access.Resolver, r *http.Request) (*access.Principal, bool) {
	principal, ok := member(w, resolver, r)
	if !ok {
		return nil, false
	}
	if status, message, allowed := access.SuperAdmin(*principal); !allowed {
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
	writeJSON(w, resp.Status, resp.JSON)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		http.Error(w, "服务暂不可用", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
