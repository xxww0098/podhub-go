package aihttp

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func (h httpHandler) openTestHold(ctx context.Context, p access.Principal, id string, in ocrTestInput, provider OCRProvider, price billing.Price, hold int64) (openedHold, Response) {
	tx, err := tenantx.BeginApp(ctx, h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	defer endTx(ctx, tx)
	key := testKey(id)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('ocr-test:'||$1::bigint::text||':'||$2::text,0))`, p.OrgID, key); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2)`, p.OrgID, key).Scan(&exists); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if exists {
		return openedHold{}, fail(409, "REQUEST_IN_FLIGHT", "测试已受理，请读取本次结果")
	}
	if h.deps.OCR.TestAuthorize(ctx, p, in.SourceID, in.ProductID) != nil {
		return openedHold{}, fail(404, "NOT_FOUND", "商品不存在或无权访问")
	}
	if h.deps.Wallet.RequireOrg == nil || h.deps.Wallet.RequireOrg(ctx, tx, p.OrgID) != nil {
		return openedHold{}, fail(500, "INTERNAL", "工作空间钱包不可用")
	}
	if resp := assertBilling(ctx, tx); resp.Status != 0 {
		return openedHold{}, resp
	}
	publicID, err := newPublicID()
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	out := openedHold{PublicID: publicID, UserID: p.UserID, Held: hold, Price: price}
	raw, _ := json.Marshal(in)
	fingerprint := testFingerprint(in)
	err = tx.QueryRow(ctx, `INSERT INTO ai_requests(public_id,org_id,user_id,idempotency_key,operation,model,upstream_account_id,status,price_schedule_id,billing_mode,per_request_microfen,input_microfen_per_million,cached_input_microfen_per_million,output_microfen_per_million,reasoning_microfen_per_million,held_microfen,api_format,input_fingerprint,authorized_units,binding_hash,binding_status,ocr_prompt,dispatched_at) VALUES($1,$2,$3,$4,'ocr',$5,$6,'dispatching',$7,$8,$9,$10,$11,$12,$13,$14,'chat_completions',$15,1,$15,'bound',$16::jsonb,clock_timestamp()) ON CONFLICT(org_id,idempotency_key) WHERE status<>'failed' DO NOTHING RETURNING id,created_at`, publicID, p.OrgID, p.UserID, key, provider.Model, provider.AccountID, price.ID, price.BillingMode, price.PerRequest, price.Input, price.CachedInput, price.Output, price.Reasoning, hold, fingerprint, string(raw)).Scan(&out.ID, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return openedHold{}, fail(409, "REQUEST_IN_FLIGHT", "测试已受理，请读取本次结果")
	}
	if err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	if hold > 0 {
		if h.deps.Wallet.HoldTx == nil {
			return openedHold{}, fail(500, "INTERNAL", "工作空间钱包不可用")
		}
		if _, err = h.deps.Wallet.HoldTx(ctx, tx, p.OrgID, publicID, &out.ID, hold); err != nil {
			var funds *billing.Error
			if errors.As(err, &funds) && funds.Insufficient {
				return openedHold{}, fail(402, "INSUFFICIENT_BALANCE", funds.Error())
			}
			return openedHold{}, fail(500, "INTERNAL", "工作空间钱包不可用")
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return openedHold{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	return out, Response{}
}
func (h httpHandler) lookupTest(ctx context.Context, p access.Principal, id, want string) (Response, bool) {
	tx, err := tenantx.BeginApp(ctx, h.deps.Pool.Begin, p.OrgID)
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用"), true
	}
	defer tx.Rollback(ctx)
	var user int64
	var raw []byte
	var fingerprint, status, requestID, model string
	var charged int64
	err = tx.QueryRow(ctx, `SELECT user_id,ocr_prompt,input_fingerprint,status,public_id,model,charged_microfen FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2 AND operation='ocr' AND job_id IS NULL AND binding_status='bound' ORDER BY id DESC LIMIT 1`, p.OrgID, testKey(id)).Scan(&user, &raw, &fingerprint, &status, &requestID, &model, &charged)
	if errors.Is(err, pgx.ErrNoRows) {
		return Response{}, false
	}
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用"), true
	}
	if user != p.UserID {
		return fail(404, "NOT_FOUND", "测试不存在"), true
	}
	var in ocrTestInput
	var stored map[string]json.RawMessage
	if json.Unmarshal(raw, &in) != nil || json.Unmarshal(raw, &stored) != nil {
		return fail(500, "INTERNAL", "测试凭据无效"), true
	}
	_ = tx.Rollback(ctx)
	if h.deps.OCR.TestAuthorize(ctx, p, in.SourceID, in.ProductID) != nil {
		return fail(404, "NOT_FOUND", "测试不存在"), true
	}
	if want != "" && want != fingerprint {
		return fail(409, "CONFLICT", "本次测试输入已固定，请读取原结果"), true
	}
	data := map[string]any{"id": id, "input": in, "billing": map[string]any{"request_id": requestID, "model": model, "status": status, "charged_microfen": charged}, "state": "running"}
	if _, err := ai.ParseProductProfile(string(stored["profile"])); err != nil {
		data["state"] = "rejected"
		data["error"] = "商品事实格式已变化，请重新测试；原始输入和账单保留。"
		return Response{Status: 200, JSON: map[string]any{"data": data}}, true
	}
	if fingerprint != testFingerprint(in) {
		return fail(500, "INTERNAL", "测试凭据无效"), true
	}
	switch status {
	case "failed":
		data["state"] = "failed"
		data["error"] = "模型调用失败，本次未计费。"
	case "unbilled_unknown":
		data["state"] = "unknown"
		data["error"] = "上游结果未知，本次未计费。请保留本次记录。"
	case "settled":
		replay, found := lookup(ctx, h.deps.Pool, p.OrgID, testKey(id), "ocr", aiclient.ChatCompletions)
		if !found || replay.Status != 200 {
			return fail(503, "RELAY_UNAVAILABLE", "测试回执正在恢复"), true
		}
		payload, ok := replay.JSON.(map[string]any)
		if !ok {
			return fail(500, "INTERNAL", "测试回执无效"), true
		}
		data["billing"] = payload["billing"]
		completion, ok := payload["completion"].(json.RawMessage)
		if !ok {
			return fail(500, "INTERNAL", "测试回执无效"), true
		}
		_, binding := testBinding(id, in)
		answer, err := h.deps.OCR.Validate(ctx, binding.Pin, completion)
		if err != nil {
			var violation *ai.ContractError
			if !errors.As(err, &violation) {
				return fail(503, "RELAY_UNAVAILABLE", "测试结果校验暂不可用"), true
			}
			data["state"] = "rejected"
			data["error"] = violation.Message
		} else {
			var result ai.Answer
			if json.Unmarshal(answer, &result) != nil {
				return fail(500, "INTERNAL", "测试结果无效"), true
			}
			data["answer"] = result
			data["state"] = "succeeded"
		}
	}
	return Response{Status: 200, JSON: map[string]any{"data": data}}, true
}
