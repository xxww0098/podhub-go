package aihttp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func ocrClaim(r *http.Request) (ai.Claim, bool) {
	epoch, err := strconv.ParseInt(r.Header.Get("X-Listing-Lease-Epoch"), 10, 64)
	c := ai.Claim{JobID: r.Header.Get("X-Listing-Job-Id"), Lease: ai.Lease{Owner: r.Header.Get("X-Listing-Lease-Owner"), Epoch: epoch}}
	_, idErr := uuid.Parse(c.JobID)
	return c, err == nil && idErr == nil && epoch > 0 && c.JobID != "" && c.Lease.Owner != ""
}
func (h httpHandler) ocrBinding(ctx context.Context, p access.Principal, c ai.Claim, key string) (ai.Binding, error) {
	if h.deps.Pool == nil || h.deps.OCR == nil || h.deps.OCR.Authorize == nil {
		return ai.Binding{}, errors.New("recognition unavailable")
	}
	tx, err := tenantx.BeginApp(ctx, h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		return ai.Binding{}, err
	}
	defer endTx(ctx, tx)
	binding, err := h.deps.OCR.Authorize(ctx, tx, p, c, key, true)
	if err != nil {
		return binding, err
	}
	return binding, tx.Commit(ctx)
}
func ocrData(w http.ResponseWriter, data any)                { jsonwire.Write(w, 200, map[string]any{"data": data}) }
func ocrFailure(w http.ResponseWriter, code, message string) { writeResp(w, fail(409, code, message)) }
func (h httpHandler) ocrUpload(w http.ResponseWriter, r *http.Request) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	c, ok := ocrClaim(r)
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "识别任务租约无效"))
		return
	}
	var body struct {
		Image  ai.Image `json:"image"`
		CardID string   `json:"card_id"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body) != nil {
		writeResp(w, fail(400, "VALIDATION", "图片上传请求无效"))
		return
	}
	binding, err := h.ocrBinding(r.Context(), *p, c, "")
	if err != nil {
		ocrFailure(w, "CONFLICT", "识别任务已变化，请刷新后重试")
		return
	}
	if h.deps.OCR.Issue == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "私有图片存储尚未配置"))
		return
	}
	target, err := h.deps.OCR.Issue(r.Context(), *p, c, binding, body.Image)
	if err != nil {
		writeResp(w, fail(422, "VALIDATION", "图片信息无效或私有存储不可用"))
		return
	}
	ocrData(w, target)
}
func (h httpHandler) ocrUploadConfirm(w http.ResponseWriter, r *http.Request) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	c, ok := ocrClaim(r)
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "识别任务租约无效"))
		return
	}
	var body struct {
		Ticket string `json:"upload_ticket"`
		CardID string `json:"card_id"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&body) != nil {
		writeResp(w, fail(400, "VALIDATION", "图片确认请求无效"))
		return
	}
	binding, err := h.ocrBinding(r.Context(), *p, c, "")
	if err != nil {
		ocrFailure(w, "CONFLICT", "识别任务已变化，请刷新后重试")
		return
	}
	if h.deps.OCR.Read == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "私有图片存储尚未配置"))
		return
	}
	raw, mime, err := h.deps.OCR.Read(r.Context(), *p, c, binding, body.Ticket)
	if errors.Is(err, ai.ErrImageMissing) {
		writeResp(w, fail(404, "MEDIA_COMPLETE_MISSING", "图片尚未上传"))
		return
	}
	if err != nil {
		writeResp(w, fail(409, "CONFLICT", "图片字节尚未确认，请重新上传"))
		return
	}
	sum := sha256.Sum256(raw)
	ocrData(w, ai.Image{Bytes: uint64(len(raw)), SHA256: hex.EncodeToString(sum[:]), ContentType: mime})
}
func (h httpHandler) ocrGet(w http.ResponseWriter, r *http.Request) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	key, ok := Key(r.Header.Get("Idempotency-Key"))
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头"))
		return
	}
	c, ok := ocrClaim(r)
	if !ok {
		writeResp(w, fail(400, "OCR_REQUIRES_CLAIM", "识别任务租约无效"))
		return
	}
	if h.deps.Pool == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别服务不可用"))
		return
	}
	if resp, found := h.lookupOCR(r.Context(), *p, c, key); found {
		if resp.Status == 200 {
			ocrData(w, resp.JSON)
		} else {
			writeResp(w, resp)
		}
		return
	}
	writeResp(w, fail(404, "NOT_FOUND", "请求不存在"))
}
func (h httpHandler) ocrPost(w http.ResponseWriter, r *http.Request) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	key, ok := Key(r.Header.Get("Idempotency-Key"))
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头"))
		return
	}
	c, ok := ocrClaim(r)
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "识别任务租约无效"))
		return
	}
	var body struct {
		Ticket string `json:"upload_ticket"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	dec.DisallowUnknownFields()
	if dec.Decode(&body) != nil || body.Ticket == "" {
		writeResp(w, fail(400, "VALIDATION", "识别请求无效"))
		return
	}
	if h.deps.Pool == nil || h.deps.OCR == nil || h.deps.OCR.Resolve == nil || h.deps.OCR.Read == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别服务尚未配置"))
		return
	}
	if resp, found := h.lookupOCR(r.Context(), *p, c, key); found {
		if resp.Status == 200 {
			ocrData(w, resp.JSON)
		} else {
			writeResp(w, resp)
		}
		return
	}
	binding, err := h.ocrBinding(r.Context(), *p, c, key)
	if err != nil {
		ocrFailure(w, "CONFLICT", "识别任务或原图已变化，请刷新后重试")
		return
	}
	pixels, mime, err := h.deps.OCR.Read(r.Context(), *p, c, binding, body.Ticket)
	if errors.Is(err, ai.ErrImageMissing) {
		writeResp(w, fail(404, "MEDIA_COMPLETE_MISSING", "图片尚未上传"))
		return
	}
	if err != nil {
		writeResp(w, fail(409, "CONFLICT", "图片字节校验未通过，请重新上传"))
		return
	}
	routing := binding.Pin.Routing
	provider, err := h.deps.OCR.Resolve(r.Context(), routing)
	if err != nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别模型尚未配置或不可用"))
		return
	}
	request, err := ai.RecognitionRequest(provider.Model, binding.Pin.Prompt, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(pixels))
	if err != nil {
		writeResp(w, fail(409, "CONFLICT", err.Error()))
		return
	}
	// After acceptance the paid request persists its result even if the browser closes.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	paid, resp := h.completeOCR(ctx, *p, provider, request, func(price billing.Price, hold int64) (openedHold, Response) {
		return h.openOCRHold(ctx, *p, c, key, provider, price, hold)
	})
	if resp.Status != 0 {
		writeResp(w, resp)
		return
	}
	folded, view := paid.Body, paid.Billing
	var row json.RawMessage
	if h.deps.OCR.Validate != nil && h.deps.OCR.Settle != nil {
		if _, err = h.deps.OCR.Validate(ctx, binding.Pin, folded); err != nil {
			var violation *ai.ContractError
			if errors.As(err, &violation) {
				jsonwire.Write(w, 422, map[string]any{"code": "OCR_CONTRACT_VIOLATION", "error": violation.Message, "ocr_recovery": map[string]any{"job_id": c.JobID, "request_id": paid.RequestID}})
				return
			}
			jsonwire.Write(w, 409, map[string]any{"code": "LISTING_WRITEBACK_PENDING", "error": "识别已结算，商品行等待恢复", "ocr_recovery": map[string]any{"job_id": c.JobID, "request_id": paid.RequestID}})
			return
		} else {
			row, err = h.deps.OCR.Settle(ctx, *p, c, paid.RequestID)
			if err != nil {
				jsonwire.Write(w, 409, map[string]any{"code": "LISTING_WRITEBACK_PENDING", "error": "识别已结算，商品行等待恢复", "ocr_recovery": map[string]any{"job_id": c.JobID, "request_id": paid.RequestID}})
				return
			}
		}
	}
	ocrData(w, map[string]any{"completion": json.RawMessage(folded), "billing": view, "listing_row": row})
}
func (h httpHandler) openOCRHold(ctx context.Context, p access.Principal, c ai.Claim, key string, provider OCRProvider, price billing.Price, hold int64) (openedHold, Response) {
	tx, err := tenantx.BeginApp(ctx, h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	defer endTx(ctx, tx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('ocr-request:'||$1::bigint::text||':'||$2::text,0))`, p.OrgID, key); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2)`, p.OrgID, key).Scan(&exists); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if exists {
		return openedHold{}, fail(409, "REQUEST_IN_FLIGHT", "识别请求已受理，请读取恢复状态")
	}
	binding, err := h.deps.OCR.Authorize(ctx, tx, p, c, key, true)
	if err != nil {
		return openedHold{}, fail(409, "CONFLICT", "识别任务已变化，请刷新后重试")
	}
	if resp := assertBilling(ctx, tx); resp.Status != 0 {
		return openedHold{}, resp
	}
	id, err := newPublicID()
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	out := openedHold{PublicID: id, UserID: p.UserID, Held: hold, Price: price}
	prompt, _ := json.Marshal(binding.Pin.Prompt)
	err = tx.QueryRow(ctx, `INSERT INTO ai_requests(public_id,org_id,user_id,idempotency_key,operation,model,upstream_account_id,status,price_schedule_id,billing_mode,per_request_microfen,input_microfen_per_million,cached_input_microfen_per_million,output_microfen_per_million,reasoning_microfen_per_million,held_microfen,api_format,job_id,input_fingerprint,authorized_units,binding_hash,binding_status,ocr_prompt,dispatched_at) VALUES($1,$2,$3,$4,'ocr',$5,$6,'dispatching',$7,$8,$9,$10,$11,$12,$13,$14,'chat_completions',$15::uuid,$16,1,$17,'bound',$18::jsonb,clock_timestamp()) RETURNING id,created_at`, id, p.OrgID, p.UserID, key, provider.Model, provider.AccountID, price.ID, price.BillingMode, price.PerRequest, price.Input, price.CachedInput, price.Output, price.Reasoning, hold, c.JobID, binding.Fingerprint, ai.BindingHash(c, binding.Fingerprint), string(prompt)).Scan(&out.ID, &out.CreatedAt)
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if hold > 0 {
		if h.deps.Wallet.HoldTx == nil {
			return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
		}
		if _, err = h.deps.Wallet.HoldTx(ctx, tx, p.OrgID, id, &out.ID, hold); err != nil {
			var funds *billing.Error
			if errors.As(err, &funds) && funds.Insufficient {
				return openedHold{}, fail(402, "INSUFFICIENT_BALANCE", funds.Error())
			}
			return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	return out, Response{}
}

func (h httpHandler) lookupOCR(ctx context.Context, p access.Principal, c ai.Claim, key string) (Response, bool) {
	tx, err := tenantx.BeginApp(ctx, h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用"), true
	}
	defer tx.Rollback(ctx)
	var actor int64
	var job, hash, fingerprint string
	var prompt, body []byte
	var status, requestID string
	err = tx.QueryRow(ctx, `SELECT user_id,job_id::text,COALESCE(binding_hash,''),COALESCE(input_fingerprint,''),ocr_prompt,response_body,status,public_id FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2 AND operation='ocr' AND binding_status='bound' AND job_id IS NOT NULL ORDER BY id DESC LIMIT 1`, p.OrgID, key).Scan(&actor, &job, &hash, &fingerprint, &prompt, &body, &status, &requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Response{}, false
	}
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用"), true
	}
	if actor != p.UserID || job != c.JobID || hash != ai.BindingHash(c, fingerprint) {
		return fail(404, "NOT_FOUND", "请求不存在"), true
	}
	if status == "settled" && len(body) > 0 && h.deps.OCR != nil && h.deps.OCR.Validate != nil {
		var pin ai.Pin
		if json.Unmarshal(prompt, &pin.Prompt) != nil {
			return fail(500, "INTERNAL", "识别凭据无效"), true
		}
		if _, err = h.deps.OCR.Validate(ctx, pin, body); err != nil {
			var violation *ai.ContractError
			if errors.As(err, &violation) {
				return Response{Status: 422, JSON: map[string]any{"code": "OCR_CONTRACT_VIOLATION", "error": violation.Message, "ocr_recovery": map[string]any{"job_id": job, "request_id": requestID}}}, true
			}
			return fail(503, "RELAY_UNAVAILABLE", "识别校验暂不可用"), true
		}
	}
	_ = tx.Rollback(ctx)
	response, found := lookup(ctx, h.deps.Pool, p.OrgID, key, "ocr", aiclient.ChatCompletions)
	if found && response.Status == 200 && h.deps.OCR != nil && h.deps.OCR.Settle != nil {
		row, err := h.deps.OCR.Settle(ctx, p, c, requestID)
		if err != nil {
			return Response{Status: 409, JSON: map[string]any{"code": "LISTING_WRITEBACK_PENDING", "error": "识别已结算，商品行等待恢复", "ocr_recovery": map[string]any{"job_id": c.JobID, "request_id": requestID}}}, true
		}
		if data, ok := response.JSON.(map[string]any); ok {
			data["listing_row"] = row
		}
	}
	return response, found
}
