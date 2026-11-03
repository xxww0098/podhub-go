package aihttp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const maxBody = aiclient.MaxBody

// Deps wires chat. Text resolves the active provider account for one model and
// format; nil refuses every text request before a hold. Limits loads the
// platform AI ceilings for one request; an error fails the request closed. Nil
// means every ceiling off with the default lease TTL.
type Deps struct {
	Pool   *pgxpool.Pool
	Text   TextResolver
	Limits func(context.Context) (Limits, error)
	Images *ImageRuntime
	OCR    *OCRRuntime
	Wallet Wallet
}

func (d Deps) limits(ctx context.Context) (Limits, Response) {
	if d.Limits == nil {
		return Limits{}, Response{}
	}
	limits, err := d.Limits(ctx)
	if err != nil {
		return Limits{}, fail(503, "RELAY_UNAVAILABLE", "AI 服务配置暂不可用")
	}
	return limits, Response{}
}

// Response is one AI HTTP result. JSON is nil when Status is zero.
type Response struct {
	Status     int
	RetryAfter string
	JSON       any
}

// Chat runs hold, one native provider call, and settle for one
// Idempotency-Key. format is the inbound wire format and the account format;
// this build never converts between them.
func Chat(ctx context.Context, deps Deps, format aiclient.Format, orgID, userID int64, idempotency string, body []byte) Response {
	if deps.Pool == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	if !format.Valid() {
		return fail(400, "VALIDATION", "不支持该 AI 接口格式")
	}
	key, ok := Key(idempotency)
	if !ok {
		return fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头")
	}
	if len(body) > maxBody {
		return fail(400, "VALIDATION", "请求格式无效")
	}
	model, err := aiclient.Model(body)
	if err != nil {
		return fail(400, "VALIDATION", "请求格式无效")
	}
	stamped, err := aiclient.Stamp(body, model, format)
	if errors.Is(err, aiclient.ErrStreaming) {
		return fail(400, "VALIDATION", "当前不支持流式响应")
	}
	if err != nil {
		return fail(400, "VALIDATION", "请求格式无效")
	}
	if replay, ok := lookup(ctx, deps.Pool, orgID, key, "ai_token", format); ok {
		return replay
	}
	if deps.Wallet.CurrentForModel == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	price, found, err := currentPrice(ctx, deps, orgID, model)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	if !found {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	if _, err := price.ChargeUsage(billing.Usage{}); err != nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	holdMicro, err := price.QuotePrepay()
	if err != nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	if deps.Text == nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型服务未配置")
	}
	provider, err := deps.Text.Resolve(ctx, model, format)
	if err != nil || provider.AccountID == "" || provider.Complete == nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型服务未配置")
	}
	limits, resp := deps.limits(ctx)
	if resp.Status != 0 {
		return resp
	}
	lease, status, message := Acquire(ctx, deps.Pool, limits, userID, provider.AccountID, true)
	if status != 0 {
		code := "BUSY"
		if status == 503 {
			code = "RELAY_UNAVAILABLE"
		}
		resp := fail(status, code, message)
		if status == 429 {
			resp.RetryAfter = "1"
		}
		return resp
	}
	defer lease.Release(context.Background())

	opened, resp := openHold(ctx, deps, orgID, userID, key, model, format, provider.AccountID, price, holdMicro)
	if resp.Status != 0 {
		return resp
	}
	statusCode, raw, err := provider.Complete(ctx, stamped)
	if err != nil {
		terminal, class := "unbilled_unknown", "transport_unknown"
		if errors.Is(err, aiclient.ErrFormat) || errors.Is(err, aiclient.ErrInvalid) {
			terminal, class = "failed", "relay_configuration"
		}
		_ = releaseRequest(ctx, deps, orgID, opened, terminal, class, nil)
		if terminal == "failed" {
			return fail(502, "UPSTREAM_FAILED", "AI 服务请求失败，本次未计费")
		}
		return fail(504, "UPSTREAM_UNKNOWN", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	if statusCode != 200 {
		return settleFault(ctx, deps, orgID, opened, statusCode, raw)
	}
	completion := raw
	if format == aiclient.ChatCompletions {
		completion, err = FoldCompletion(raw)
		if err != nil {
			_ = releaseRequest(ctx, deps, orgID, opened, "unbilled_unknown", "missing_usage", raw)
			return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
		}
	}
	usage, responseID, err := ParseUsage(format, completion)
	if err != nil {
		_ = releaseRequest(ctx, deps, orgID, opened, "unbilled_unknown", "missing_usage", completion)
		return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	charge, err := opened.Price.ChargeUsage(usage)
	if err != nil {
		_ = releaseRequest(ctx, deps, orgID, opened, "unbilled_unknown", "usage_not_priceable", completion)
		return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	view, err := settleRequest(ctx, deps, orgID, opened, usage, charge, responseID, completion)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	return Response{Status: 200, JSON: map[string]any{
		"completion": json.RawMessage(completion), "billing": view, "listing_row": nil,
	}}
}

// currentPrice reads the in-effect price through the tenant role. The price
// table is not readable by the login role, so a bare pool read is denied;
// every tenant query has to enter podhub_app inside its transaction.
func currentPrice(ctx context.Context, deps Deps, orgID int64, model string) (billing.Price, bool, error) {
	tx, err := tenantx.BeginApp(ctx, deps.Pool.Begin, orgID)
	if err != nil {
		return billing.Price{}, false, err
	}
	defer tx.Rollback(ctx)
	return deps.Wallet.CurrentForModel(ctx, tx, model)
}

type openedHold struct {
	ID        int64
	PublicID  string
	UserID    int64
	Held      int64
	CreatedAt time.Time
	Price     billing.Price
}

func openHold(ctx context.Context, deps Deps, orgID, userID int64, key, model string, format aiclient.Format, accountID string, price billing.Price, hold int64) (openedHold, Response) {
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	defer endTx(ctx, tx)
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if deps.Wallet.RequireOrg == nil || deps.Wallet.RequireOrg(ctx, tx, orgID) != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if resp := assertBilling(ctx, tx); resp.Status != 0 {
		return openedHold{}, resp
	}
	publicID, err := newPublicID()
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	var opened openedHold
	opened.Price = price
	opened.PublicID = publicID
	opened.UserID = userID
	opened.Held = hold
	err = tx.QueryRow(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id,
		     status, price_schedule_id, billing_mode, per_request_microfen,
		     input_microfen_per_million, cached_input_microfen_per_million,
		     output_microfen_per_million, reasoning_microfen_per_million, held_microfen,
		     thinking_depth, channel_name, api_format, dispatched_at)
		VALUES ($1, $2, $3, $4, 'ai_token', $5, $6, 'dispatching', $7, $8, $9, $10, $11, $12, $13, $14,
		        NULL, NULL, $15, clock_timestamp())
		ON CONFLICT (org_id, idempotency_key) WHERE status <> 'failed' DO NOTHING
		RETURNING id, created_at`,
		publicID, orgID, userID, key, model, accountID, price.ID, price.BillingMode, price.PerRequest,
		price.Input, price.CachedInput, price.Output, price.Reasoning, hold, string(format)).Scan(&opened.ID, &opened.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		resp := fail(409, "REQUEST_IN_FLIGHT", "相同 Idempotency-Key 的请求仍在处理")
		resp.RetryAfter = "1"
		return openedHold{}, resp
	}
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if hold > 0 {
		if deps.Wallet.HoldTx == nil {
			return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
		}
		if _, err := deps.Wallet.HoldTx(ctx, tx, orgID, publicID, &opened.ID, hold); err != nil {
			var funds *billing.Error
			if errors.As(err, &funds) && funds.Insufficient {
				return openedHold{}, fail(402, "INSUFFICIENT_BALANCE", funds.Error())
			}
			return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	return opened, Response{}
}

func settleRequest(ctx context.Context, deps Deps, orgID int64, opened openedHold, usage billing.Usage, charge billing.Charge, responseID string, body []byte) (billingView, error) {
	return settleRequestWith(ctx, deps, orgID, opened, usage, charge, responseID, body, nil)
}

// settleRequestWith pins an image result in the same transaction as its wallet charge.
func settleRequestWith(ctx context.Context, deps Deps, orgID int64, opened openedHold, usage billing.Usage, charge billing.Charge, responseID string, body []byte, persist func(pgx.Tx) error) (billingView, error) {
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return billingView{}, err
	}
	defer endTx(ctx, tx)
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return billingView{}, err
	}
	if _, err := writer.Assert(ctx, tx, "billing", writer.ProcessIdentity(), time.Now().UnixMilli(), "计费写入未启用"); err != nil {
		return billingView{}, err
	}
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM ai_requests WHERE id = $1 FOR UPDATE`, opened.ID).Scan(&status); err != nil {
		return billingView{}, err
	}
	if status != "held" && status != "dispatching" {
		return billingView{}, errors.New("terminal")
	}
	charged, absorbed := int64(0), charge.Total
	if opened.Held > 0 {
		if deps.Wallet.SettleTx == nil {
			return billingView{}, errWalletNotWired
		}
		wallet, err := deps.Wallet.SettleTx(ctx, tx, orgID, opened.PublicID, &opened.ID, opened.Held, charge.Total)
		if err != nil {
			return billingView{}, err
		}
		charged, absorbed = wallet.ChargedMicrofen, wallet.AbsorbedMicrofen
	}
	var upstream *string
	if responseID != "" {
		upstream = &responseID
	}
	var settledAt time.Time
	if err := tx.QueryRow(ctx, `
		UPDATE ai_requests
		   SET status = 'settled',
		       prompt_tokens = $2, cached_prompt_tokens = $3,
		       completion_tokens = $4, reasoning_completion_tokens = $5,
		       uncached_input_microfen = $6, cached_input_microfen = $7,
		       output_microfen = $8, reasoning_microfen = $9, total_microfen = $10,
		       charged_microfen = $11, absorbed_microfen = $12,
		       upstream_response_id = $13, response_body = $14,
		       settled_at = clock_timestamp(), updated_at = clock_timestamp()
		 WHERE id = $1
		RETURNING settled_at`,
		opened.ID, int64(usage.PromptTokens), int64(usage.CachedPromptTokens), int64(usage.CompletionTokens), int64(usage.ReasoningCompletionTokens),
		charge.UncachedInput, charge.CachedInput, charge.Output, charge.Reasoning, charge.Total,
		charged, absorbed, upstream, body).Scan(&settledAt); err != nil {
		return billingView{}, err
	}
	var username string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(name, '') FROM account_users WHERE id = $1`, opened.UserID).Scan(&username); err != nil {
		return billingView{}, err
	}
	other, err := logOther(charge, charged, absorbed, int(usage.CachedPromptTokens))
	if err != nil {
		return billingView{}, err
	}
	use := int(time.Since(opened.CreatedAt).Seconds())
	if use < 0 {
		use = 0
	}
	if err := insertConsumeLog(ctx, tx, consumeLog{
		OrgID: orgID, RequestID: opened.ID, UserID: opened.UserID, CreatedAt: time.Now().Unix(),
		Content: fmt.Sprintf("quota %d", charge.Total), Username: username, Model: opened.Price.Model,
		Quota: int(charge.Total), Prompt: int(usage.PromptTokens), Completion: int(usage.CompletionTokens),
		UseTime: use, Group: "default", IP: clientIPFrom(ctx),
		PublicID: opened.PublicID, UpstreamID: responseID, Other: other,
	}); err != nil {
		return billingView{}, err
	}
	if persist != nil {
		if err := persist(tx); err != nil {
			return billingView{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return billingView{}, err
	}
	view := viewFrom(opened, "settled", usage, charge, charged, absorbed, nil)
	text := billing.RFC3339Millis(settledAt)
	view.SettledAt = &text
	return view, nil
}

func releaseRequest(ctx context.Context, deps Deps, orgID int64, opened openedHold, status, class string, body []byte) error {
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer endTx(ctx, tx)
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	if resp := assertBilling(ctx, tx); resp.Status != 0 {
		return errors.New("billing writes disabled")
	}
	var current string
	var held int64
	if err := tx.QueryRow(ctx, `SELECT status, held_microfen FROM ai_requests WHERE id = $1 FOR UPDATE`, opened.ID).Scan(&current, &held); err != nil {
		return err
	}
	if current != "held" && current != "dispatching" {
		return nil
	}
	if held > 0 {
		if deps.Wallet.ReleaseTx == nil {
			return errWalletNotWired
		}
		if _, err := deps.Wallet.ReleaseTx(ctx, tx, orgID, opened.PublicID, &opened.ID, held, class); err != nil {
			return err
		}
	}
	var raw []byte
	if len(body) > 0 {
		raw = body
	}
	_, err = tx.Exec(ctx, `
		UPDATE ai_requests
		   SET status = $2, error_class = $3, response_body = $4,
		       settled_at = clock_timestamp(), updated_at = clock_timestamp()
		 WHERE id = $1`, opened.ID, status, class, raw)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func settleFault(ctx context.Context, deps Deps, orgID int64, opened openedHold, status int, body []byte) Response {
	terminal := "unbilled_unknown"
	class := "upstream_request_error"
	code := "UPSTREAM_FAILED"
	message := "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试"
	switch {
	case status == 401 || status == 403:
		terminal, class = "failed", "upstream_credentials"
		code = "UPSTREAM_CREDENTIALS"
		message = "AI 服务请求失败，本次未计费"
	case status == 400 || status == 404 || status == 405 || status == 406 || status == 411 || status == 413 || status == 414 || status == 415 || status == 422 || status == 431:
		terminal, class = "failed", "upstream_request_error"
		message = "AI 服务请求失败，本次未计费"
	case status == 429:
		class = "upstream_rate_limited"
	case status >= 500 && status <= 599:
		class = "upstream_server_error"
	}
	if err := releaseRequest(ctx, deps, orgID, opened, terminal, class, body); err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	return fail(502, code, message)
}

func lookup(ctx context.Context, pool *pgxpool.Pool, orgID int64, key, operation string, format aiclient.Format) (Response, bool) {
	var row struct {
		Operation string
		Format    string
		Status    string
		Body      []byte
		Class     *string
		View      billingView
	}
	var created, settled *time.Time
	tx, err := tenantx.BeginApp(ctx, pool.Begin, orgID)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用"), true
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `
		SELECT operation, api_format, status, response_body, error_class, public_id, model,
		       prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_completion_tokens,
		       uncached_input_microfen, cached_input_microfen, output_microfen, reasoning_microfen,
		       total_microfen, charged_microfen, absorbed_microfen, held_microfen,
		       billing_mode, per_request_microfen, input_microfen_per_million, cached_input_microfen_per_million,
		       output_microfen_per_million, reasoning_microfen_per_million, price_schedule_id,
		       created_at, settled_at
		  FROM ai_requests
		 WHERE org_id = $1 AND idempotency_key = $2
		 ORDER BY id DESC LIMIT 1`, orgID, key).Scan(
		&row.Operation, &row.Format, &row.Status, &row.Body, &row.Class, &row.View.RequestID, &row.View.Model,
		&row.View.PromptTokens, &row.View.CachedPromptTokens, &row.View.CompletionTokens, &row.View.ReasoningCompletionTokens,
		&row.View.UncachedInput, &row.View.CachedInput, &row.View.Output, &row.View.Reasoning,
		&row.View.Total, &row.View.Charged, &row.View.Absorbed, &row.View.Price.MaxRequest,
		&row.View.Price.BillingMode, &row.View.Price.PerRequest, &row.View.Price.Input, &row.View.Price.CachedInput,
		&row.View.Price.Output, &row.View.Price.Reasoning, &row.View.Price.ID, &created, &settled)
	if errors.Is(err, pgx.ErrNoRows) {
		return Response{}, false
	}
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用"), true
	}
	if row.Operation != operation {
		return fail(400, "VALIDATION", "相同 Idempotency-Key 不能复用于另一种 AI 操作"), true
	}
	if row.Format != "" && row.Format != string(format) {
		return fail(409, "IDEMPOTENCY_CONFLICT", "相同 Idempotency-Key 不能复用于另一种 AI 接口格式"), true
	}
	row.View.Status = row.Status
	row.View.ErrorClass = row.Class
	if created != nil {
		row.View.CreatedAt = billing.RFC3339Millis(*created)
		row.View.Price.EffectiveFrom = row.View.CreatedAt
	}
	if settled != nil {
		text := billing.RFC3339Millis(*settled)
		row.View.SettledAt = &text
	}
	row.View.Price.Model = row.View.Model
	switch row.Status {
	case "failed":
		if operation == "ocr" {
			return fail(409, "REQUEST_ENDED", "该识别请求已失败，请读取任务恢复状态"), true
		}
		return Response{}, false
	case "held", "dispatching":
		resp := fail(409, "REQUEST_IN_FLIGHT", "相同 Idempotency-Key 的请求仍在处理")
		resp.RetryAfter = "1"
		return resp, true
	case "settled":
		if len(row.Body) == 0 {
			return fail(409, "REQUEST_ENDED", fmt.Sprintf("相同 Idempotency-Key 的请求已结束（%s），请换用新的 Key", row.Status)), true
		}
		return Response{Status: 200, JSON: map[string]any{
			"completion": json.RawMessage(row.Body), "billing": row.View, "listing_row": nil,
		}}, true
	case "unbilled_unknown":
		return fail(409, "REQUEST_UNBILLED_UNKNOWN", fmt.Sprintf("相同 Idempotency-Key 的请求已结束（%s），请换用新的 Key", row.Status)), true
	default:
		return fail(409, "REQUEST_ENDED", fmt.Sprintf("相同 Idempotency-Key 的请求已结束（%s），请换用新的 Key", row.Status)), true
	}
}

type billingView struct {
	RequestID                 string    `json:"request_id"`
	Model                     string    `json:"model"`
	Status                    string    `json:"status"`
	PromptTokens              int64     `json:"prompt_tokens"`
	CachedPromptTokens        int64     `json:"cached_prompt_tokens"`
	CompletionTokens          int64     `json:"completion_tokens"`
	ReasoningCompletionTokens int64     `json:"reasoning_completion_tokens"`
	UncachedInput             int64     `json:"uncached_input_microfen"`
	CachedInput               int64     `json:"cached_input_microfen"`
	Output                    int64     `json:"output_microfen"`
	Reasoning                 int64     `json:"reasoning_microfen"`
	Total                     int64     `json:"total_microfen"`
	Charged                   int64     `json:"charged_microfen"`
	Absorbed                  int64     `json:"absorbed_microfen"`
	ErrorClass                *string   `json:"error_class"`
	Price                     priceView `json:"price"`
	CreatedAt                 string    `json:"created_at"`
	SettledAt                 *string   `json:"settled_at"`
}

type priceView struct {
	ID            int64  `json:"id"`
	Model         string `json:"model"`
	BillingMode   string `json:"billing_mode"`
	Input         int64  `json:"input_microfen_per_million"`
	CachedInput   int64  `json:"cached_input_microfen_per_million"`
	Output        int64  `json:"output_microfen_per_million"`
	Reasoning     int64  `json:"reasoning_microfen_per_million"`
	PerRequest    int64  `json:"per_request_microfen"`
	MaxRequest    int64  `json:"max_request_microfen"`
	EffectiveFrom string `json:"effective_from"`
}

func viewFrom(opened openedHold, status string, usage billing.Usage, charge billing.Charge, charged, absorbed int64, class *string) billingView {
	created := billing.RFC3339Millis(opened.CreatedAt)
	settled := billing.RFC3339Millis(time.Now())
	return billingView{
		RequestID: opened.PublicID, Model: opened.Price.Model, Status: status,
		PromptTokens: int64(usage.PromptTokens), CachedPromptTokens: int64(usage.CachedPromptTokens),
		CompletionTokens: int64(usage.CompletionTokens), ReasoningCompletionTokens: int64(usage.ReasoningCompletionTokens),
		UncachedInput: charge.UncachedInput, CachedInput: charge.CachedInput, Output: charge.Output, Reasoning: charge.Reasoning, Total: charge.Total,
		Charged: charged, Absorbed: absorbed, ErrorClass: class,
		Price: priceView{
			ID: opened.Price.ID, Model: opened.Price.Model, BillingMode: opened.Price.BillingMode,
			Input: opened.Price.Input, CachedInput: opened.Price.CachedInput, Output: opened.Price.Output, Reasoning: opened.Price.Reasoning,
			PerRequest: opened.Price.PerRequest, MaxRequest: opened.Held, EffectiveFrom: created,
		},
		CreatedAt: created, SettledAt: &settled,
	}
}

func endTx(ctx context.Context, tx pgx.Tx) {
	if tx == nil {
		return
	}
	_ = tx.Rollback(ctx)
	writer.Forget(tx)
}

func assertBilling(ctx context.Context, tx pgx.Tx) Response {
	_, err := writer.Assert(ctx, tx, "billing", writer.ProcessIdentity(), time.Now().UnixMilli(), "计费写入未启用")
	if err == nil {
		return Response{}
	}
	if writer.IsDisabled(err) {
		return fail(503, "WRITES_DISABLED", err.Error())
	}
	return fail(500, "INTERNAL", "服务暂不可用")
}

func newPublicID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "air_" + hex.EncodeToString(buf[:]), nil
}

func fail(status int, code, message string) Response {
	return Response{Status: status, JSON: errBody(code, message)}
}

func errBody(code, message string) map[string]string {
	return map[string]string{"error": message, "code": code}
}
