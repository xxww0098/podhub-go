package aihttp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/llm"
	"github.com/xxww0098/podhub-go/internal/platform/newapibilling"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const maxBody = 2 * 1024 * 1024

// Upstream posts one Chat Completions body. The host still checks the URL is loopback.
type Upstream interface {
	Complete(ctx context.Context, endpoint string, body []byte) (status int, response []byte, err error)
}

// HTTPUpstream is the loopback client. It refuses any host that is not loopback.
type HTTPUpstream struct {
	Client *http.Client
}

// defaultUpstreamClient does not follow redirects and does not use a proxy.
var defaultUpstreamClient = httpx.RestrictedClient()

func (h HTTPUpstream) Complete(ctx context.Context, endpoint string, body []byte) (int, []byte, error) {
	if err := Loopback(endpoint); err != nil {
		return 0, nil, err
	}
	client := h.Client
	if client == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		client = defaultUpstreamClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	return resp.StatusCode, raw, err
}

// Loopback refuses a URL whose host is not 127.0.0.1, localhost, or ::1.
func Loopback(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return nil
	default:
		return errors.New("upstream host refused")
	}
}

// Deps wires chat. A nil Converter uses llm.Default. A nil Upstream uses HTTPUpstream.
// Limits nil reads the environment. BaseURL empty refuses before a hold.
type Deps struct {
	Pool      *pgxpool.Pool
	Upstream  Upstream
	Converter llm.Converter
	BaseURL   string
	AccountID string
	Limits    *Limits
}

func (d Deps) limits() Limits {
	if d.Limits != nil {
		return *d.Limits
	}
	return LimitsFromEnv()
}

func (d Deps) account() string {
	if d.AccountID != "" {
		return d.AccountID
	}
	return "loopback"
}

func (d Deps) converter() llm.Converter {
	if d.Converter != nil {
		return d.Converter
	}
	return llm.Default()
}

func (d Deps) upstream() Upstream {
	if d.Upstream != nil {
		return d.Upstream
	}
	return HTTPUpstream{}
}

// Response is one AI HTTP result. JSON is nil when Status is zero.
type Response struct {
	Status     int
	RetryAfter string
	JSON       any
}

// Chat runs hold, loopback completion, and settle for one Idempotency-Key.
func Chat(ctx context.Context, deps Deps, orgID, userID int64, idempotency string, body []byte) Response {
	if deps.Pool == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	key, ok := Key(idempotency)
	if !ok {
		return fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头")
	}
	if len(body) > maxBody {
		return fail(400, "VALIDATION", "请求格式无效")
	}
	model, err := requestModel(body)
	if err != nil {
		return fail(400, "VALIDATION", "请求格式无效")
	}
	if replay, ok := lookup(ctx, deps.Pool, orgID, key, "ai_token"); ok {
		return replay
	}
	endpoint, err := endpoint(deps.BaseURL)
	if err != nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	price, found, err := billing.CurrentForModel(ctx, deps.Pool, model)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	if !found {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	schedule := scheduleOf(price)
	if _, err := newapibilling.QuoteSettle(schedule, newapibilling.Usage{}); err != nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	holdMicro, err := newapibilling.QuotePrepay(schedule, EstimatePromptTokens(body))
	if err != nil {
		return fail(503, "RELAY_UNAVAILABLE", "模型价格未发布")
	}
	lease, status, message := Acquire(ctx, deps.Pool, deps.limits(), userID, deps.account(), true)
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

	opened, resp := openHold(ctx, deps, orgID, userID, key, model, price, holdMicro)
	if resp.Status != 0 {
		return resp
	}
	stamped, err := Stamp(body, model)
	if err != nil {
		_ = releaseRequest(ctx, deps.Pool, orgID, opened, "failed", "invalid_request", nil)
		return fail(502, "UPSTREAM_FAILED", "AI 服务请求失败，本次未计费")
	}
	if err := deps.converter().AcceptChat(ctx, stamped, model); err != nil {
		slog.Warn("relaykit accept chat", "err", err)
	}
	statusCode, raw, err := deps.upstream().Complete(ctx, endpoint, stamped)
	if err != nil {
		class := "transport_unknown"
		terminal := "unbilled_unknown"
		if Loopback(endpoint) != nil {
			class = "relay_configuration"
			terminal = "failed"
		}
		_ = releaseRequest(ctx, deps.Pool, orgID, opened, terminal, class, nil)
		if terminal == "failed" {
			return fail(502, "UPSTREAM_FAILED", "AI 服务请求失败，本次未计费")
		}
		return fail(504, "UPSTREAM_UNKNOWN", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	if statusCode != http.StatusOK {
		return settleFault(ctx, deps.Pool, orgID, opened, statusCode, raw)
	}
	folded, err := FoldCompletion(raw)
	if err != nil {
		_ = releaseRequest(ctx, deps.Pool, orgID, opened, "unbilled_unknown", "missing_usage", raw)
		return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	if err := deps.converter().AcceptCompletion(ctx, folded, model); err != nil {
		slog.Warn("relaykit accept completion", "err", err)
	}
	usage, responseID, err := ParseUsage(folded)
	if err != nil {
		_ = releaseRequest(ctx, deps.Pool, orgID, opened, "unbilled_unknown", "missing_usage", folded)
		return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	narrow, err := narrowUsage(usage)
	if err != nil {
		_ = releaseRequest(ctx, deps.Pool, orgID, opened, "unbilled_unknown", "usage_not_priceable", folded)
		return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	settled, err := newapibilling.QuoteSettle(scheduleOf(opened.Price), narrow)
	if err != nil {
		_ = releaseRequest(ctx, deps.Pool, orgID, opened, "unbilled_unknown", "usage_not_priceable", folded)
		return fail(502, "UPSTREAM_UNBILLABLE", "AI 服务请求失败，本次未计费，请更换新的 Idempotency-Key 重试")
	}
	view, err := settleRequest(ctx, deps.Pool, orgID, opened, usage, settled, responseID, folded)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	return Response{Status: 200, JSON: map[string]any{
		"completion": json.RawMessage(folded), "billing": view, "listing_row": nil,
	}}
}

type openedHold struct {
	ID        int64
	PublicID  string
	UserID    int64
	Held      int64
	CreatedAt time.Time
	Price     billing.Price
}

func openHold(ctx context.Context, deps Deps, orgID, userID int64, key, model string, price billing.Price, hold int64) (openedHold, Response) {
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	defer endTx(ctx, tx)
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil || billing.RequireOrg(ctx, tx, orgID) != nil {
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
		        NULL, NULL, 'chat_completions', clock_timestamp())
		ON CONFLICT (org_id, idempotency_key) WHERE status <> 'failed' DO NOTHING
		RETURNING id, created_at`,
		publicID, orgID, userID, key, model, deps.account(), price.ID, price.BillingMode, price.PerRequest,
		price.Input, price.CachedInput, price.Output, price.Reasoning, hold).Scan(&opened.ID, &opened.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		resp := fail(409, "REQUEST_IN_FLIGHT", "相同 Idempotency-Key 的请求仍在处理")
		resp.RetryAfter = "1"
		return openedHold{}, resp
	}
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if hold > 0 {
		if _, err := billing.HoldTx(ctx, tx, orgID, publicID, &opened.ID, hold); err != nil {
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

func settleRequest(ctx context.Context, pool *pgxpool.Pool, orgID int64, opened openedHold, usage billing.Usage, settled newapibilling.Settlement, responseID string, body []byte) (billingView, error) {
	tx, err := pool.Begin(ctx)
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
	charged, absorbed := int64(0), settled.Microfen
	if opened.Held > 0 {
		wallet, err := billing.SettleTx(ctx, tx, orgID, opened.PublicID, &opened.ID, opened.Held, settled.Microfen)
		if err != nil {
			return billingView{}, err
		}
		charged, absorbed = wallet.ChargedMicrofen, wallet.AbsorbedMicrofen
	}
	charge := billing.Charge{
		UncachedInput: settled.Uncached, CachedInput: settled.Cached,
		Output: settled.Output, Reasoning: settled.Reasoning, Total: settled.Microfen,
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
	other, err := logOther(settled, charged, absorbed, int(usage.CachedPromptTokens))
	if err != nil {
		return billingView{}, err
	}
	use := int(time.Since(opened.CreatedAt).Seconds())
	if use < 0 {
		use = 0
	}
	if err := insertConsumeLog(ctx, tx, consumeLog{
		OrgID: orgID, RequestID: opened.ID, UserID: opened.UserID, CreatedAt: time.Now().Unix(),
		Content: fmt.Sprintf("quota %d", settled.Quota), Username: username, Model: opened.Price.Model,
		Quota: settled.Quota, Prompt: int(usage.PromptTokens), Completion: int(usage.CompletionTokens),
		UseTime: use, Group: newapibilling.UsingGroup, IP: clientIPFrom(ctx),
		PublicID: opened.PublicID, UpstreamID: responseID, Other: other,
	}); err != nil {
		return billingView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return billingView{}, err
	}
	view := viewFrom(opened, "settled", usage, charge, charged, absorbed, nil)
	text := billing.RFC3339Millis(settledAt)
	view.SettledAt = &text
	return view, nil
}

func releaseRequest(ctx context.Context, pool *pgxpool.Pool, orgID int64, opened openedHold, status, class string, body []byte) error {
	tx, err := pool.Begin(ctx)
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
		if _, err := billing.ReleaseTx(ctx, tx, orgID, opened.PublicID, &opened.ID, held, class); err != nil {
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

func settleFault(ctx context.Context, pool *pgxpool.Pool, orgID int64, opened openedHold, status int, body []byte) Response {
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
	if err := releaseRequest(ctx, pool, orgID, opened, terminal, class, body); err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	return fail(502, code, message)
}

func lookup(ctx context.Context, pool *pgxpool.Pool, orgID int64, key, operation string) (Response, bool) {
	var row struct {
		Operation string
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
		SELECT operation, status, response_body, error_class, public_id, model,
		       prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_completion_tokens,
		       uncached_input_microfen, cached_input_microfen, output_microfen, reasoning_microfen,
		       total_microfen, charged_microfen, absorbed_microfen, held_microfen,
		       billing_mode, per_request_microfen, input_microfen_per_million, cached_input_microfen_per_million,
		       output_microfen_per_million, reasoning_microfen_per_million, price_schedule_id,
		       created_at, settled_at
		  FROM ai_requests
		 WHERE org_id = $1 AND idempotency_key = $2
		 ORDER BY id DESC LIMIT 1`, orgID, key).Scan(
		&row.Operation, &row.Status, &row.Body, &row.Class, &row.View.RequestID, &row.View.Model,
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

func requestModel(body []byte) (string, error) {
	var object struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &object); err != nil || object.Model == "" || len(object.Model) > 128 {
		return "", errInvalid
	}
	return object.Model, nil
}

func endpoint(base string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return "", errors.New("no upstream")
	}
	raw := base + "/chat/completions"
	if err := Loopback(raw); err != nil {
		return "", err
	}
	return raw, nil
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

func scheduleOf(price billing.Price) newapibilling.Schedule {
	return newapibilling.Schedule{
		Model: price.Model, Mode: price.BillingMode,
		Input: price.Input, Cached: price.CachedInput, Output: price.Output, Reasoning: price.Reasoning,
		PerRequest: price.PerRequest, MaxRequest: price.MaxRequest,
	}
}

func narrowUsage(usage billing.Usage) (newapibilling.Usage, error) {
	conv := func(n uint64) (int, error) {
		if n > math.MaxInt32 {
			return 0, newapibilling.ErrOverflow
		}
		return int(n), nil
	}
	prompt, err := conv(usage.PromptTokens)
	if err != nil {
		return newapibilling.Usage{}, err
	}
	completion, err := conv(usage.CompletionTokens)
	if err != nil {
		return newapibilling.Usage{}, err
	}
	cached, err := conv(usage.CachedPromptTokens)
	if err != nil {
		return newapibilling.Usage{}, err
	}
	reasoning, err := conv(usage.ReasoningCompletionTokens)
	if err != nil {
		return newapibilling.Usage{}, err
	}
	return newapibilling.Usage{Prompt: prompt, Completion: completion, Cached: cached, Reasoning: reasoning}, nil
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
