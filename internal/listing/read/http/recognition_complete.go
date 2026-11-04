package readhttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

func (h Host) SettleOCR(ctx context.Context, p access.Principal, claim ai.Claim, requestID string) (json.RawMessage, error) {
	var result json.RawMessage
	err := h.mediaTx(ctx, p, func(tx pgx.Tx) error {
		binding, err := h.AuthorizeOCR(ctx, tx, p, claim, "", false)
		if err != nil {
			return err
		}
		var completion, prompt []byte
		var model, fingerprint, status, epoch string
		var charged int64
		err = tx.QueryRow(ctx, `SELECT response_body,ocr_prompt,model,COALESCE(input_fingerprint,''),status,charged_microfen,COALESCE(binding_hash,'') FROM ai_requests WHERE org_id=$1 AND user_id=$2 AND public_id=$3 AND job_id=$4::uuid AND operation='ocr' AND binding_status='bound' FOR SHARE`, p.OrgID, p.UserID, requestID, claim.JobID).Scan(&completion, &prompt, &model, &fingerprint, &status, &charged, &epoch)
		if err != nil {
			return err
		}
		if status != "settled" || fingerprint != binding.Fingerprint || epoch != ai.BindingHash(claim, binding.Fingerprint) {
			return rowRefuse{409, "识别付款尚未结算或不属于当前任务", "conflict"}
		}
		result, err = h.applyRecognitionReceipt(ctx, tx, p, claim.JobID, binding, completion, requestID, model, charged)
		return err
	})
	return result, err
}

func (h Host) applyRecognitionReceipt(ctx context.Context, tx pgx.Tx, p access.Principal, jobID string, binding ai.Binding, completion []byte, requestID, model string, charged int64) (json.RawMessage, error) {
	row, card, err := mediaRow(ctx, tx, p.OrgID, p.UserID, binding.RowID)
	if err != nil {
		return nil, err
	}
	var state string
	if err = tx.QueryRow(ctx, `SELECT state FROM jobs WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, jobID).Scan(&state); err != nil {
		return nil, err
	}
	if state == "succeeded" {
		if recognitionRequestID(row.row.Payload) != requestID {
			return nil, rowRefuse{409, "商品行识别结果已变化，不能覆盖当前内容", "conflict"}
		}
		row, err = markRecognitionReady(ctx, tx, p, row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(ProjectRow(row.row))
	}
	if h.core() == nil {
		return nil, errors.New("recognition core unavailable")
	}
	parsed, err := h.ValidateOCR(ctx, binding.Pin, completion)
	if err != nil {
		return nil, err
	}
	var answer ai.Answer
	if json.Unmarshal(parsed, &answer) != nil {
		return nil, errors.New("recognition answer invalid")
	}
	schema, _, err := h.schemaFor((&http.Request{}).WithContext(ctx), tx, card)
	if err != nil {
		return nil, err
	}
	input, err := json.Marshal(map[string]any{"card": json.RawMessage(card), "row": json.RawMessage(row.row.Payload), "nowMs": h.clock().UnixMilli(), "ru": answer.RU, "description": answer.Description, "tags": answer.Tags, "candidates": answer.Candidates, "model": model, "costMicrofen": charged, "requestId": requestID, "promptSha256": binding.Pin.Prompt.SHA256})
	if err != nil {
		return nil, err
	}
	output, err := h.core().Call(ctx, core.OpSettleRecognition, schema, input)
	if err != nil {
		status, message, code := refuseCore(err)
		return nil, rowRefuse{status, message, code}
	}
	edited, err := decodeRowEdit(output)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT public.release_execution_permit('job',$1,$2)`, jobID, binding.Lease.Epoch); err != nil {
		return nil, err
	}
	if err = settleMedia(ctx, tx, p.OrgID, jobID, "succeeded", ""); err != nil {
		return nil, err
	}
	// Recognition is complete even when publication fields or candidate
	// decisions still need work. Those remain independent validation facts.
	saved, err := h.saveMediaRow(ctx, tx, p, row.row.ID, edited.Row, row.row.Media, true, factState(edited.Fact), "ready")
	if err != nil {
		return nil, err
	}
	return json.Marshal(ProjectRow(saved.row))
}

func recognitionRequestID(payload []byte) string {
	var stored struct {
		AI struct {
			RequestID string `json:"requestId"`
		} `json:"ai"`
	}
	if json.Unmarshal(payload, &stored) != nil {
		return ""
	}
	return stored.AI.RequestID
}

// Only callers holding the row and matching settled receipt may repair this
// projection. It does not rewrite manual fields or change the input revision.
func markRecognitionReady(ctx context.Context, tx pgx.Tx, p access.Principal, row storedScan) (storedScan, error) {
	if row.row.Content == "ready" {
		return row, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE listing_rows SET content_state='ready',updated_by=$3,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, row.row.ID, p.UserID); err != nil {
		return storedScan{}, err
	}
	return scanStoredRow(tx.QueryRow(ctx, `SELECT `+rowColumns+` FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, row.row.ID))
}
func (h Host) settleRecognition(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		mediaError(w, rowRefuse{400, "商品行编号无效", "validation"})
		return
	}
	var body struct {
		JobID     string   `json:"job_id"`
		Lease     ai.Lease `json:"lease"`
		RequestID string   `json:"request_id"`
	}
	if readMediaBody(r, &body) != nil || body.RequestID == "" {
		mediaError(w, rowRefuse{400, "识别回写请求无效", "validation"})
		return
	}
	var found bool
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM jobs WHERE org_id=$1 AND id=$2::uuid AND aggregate_id=$3::uuid)`, p.OrgID, body.JobID, id).Scan(&found)
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	if !found {
		mediaError(w, rowRefuse{404, "商品行或任务不存在", "not_found"})
		return
	}
	row, err := h.SettleOCR(r.Context(), p, ai.Claim{JobID: body.JobID, Lease: body.Lease}, body.RequestID)
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, row)
}
func (h Host) failRecognition(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		mediaError(w, rowRefuse{400, "商品行编号无效", "validation"})
		return
	}
	var body struct {
		JobID   string   `json:"job_id"`
		Lease   ai.Lease `json:"lease"`
		Code    string   `json:"error_code"`
		Message string   `json:"message"`
	}
	if readMediaBody(r, &body) != nil {
		mediaError(w, rowRefuse{400, "识别失败请求无效", "validation"})
		return
	}
	var result RowView
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		binding, err := h.AuthorizeOCR(r.Context(), tx, p, ai.Claim{JobID: body.JobID, Lease: body.Lease}, "", false)
		if err != nil {
			return err
		}
		if binding.RowID != id {
			return rowRefuse{409, "识别任务不属于该商品行", "conflict"}
		}
		var state string
		if err = tx.QueryRow(r.Context(), `SELECT state FROM jobs WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, body.JobID).Scan(&state); err != nil {
			return err
		}
		if state == "succeeded" {
			row, _, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
			if err == nil {
				result = ProjectRow(row.row)
			}
			return err
		}
		var pending bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM ai_requests WHERE org_id=$1 AND job_id=$2::uuid AND status IN ('held','dispatching','unbilled_unknown'))`, p.OrgID, body.JobID).Scan(&pending); err != nil {
			return err
		}
		if pending {
			return rowRefuse{409, "识别付款仍待恢复，不能覆盖为失败", "ocr_recovery_required"}
		}
		code, message := "ocr_preparation_failed", "识图步骤未完成，请检查原图、商品事实和模型配置后重试"
		switch body.Code {
		case "workflow_source_missing":
			code, message = body.Code, "本机没有该源图，请重新导入后再识别"
		case "workflow_recognition_contract_changed":
			code, message = body.Code, "识图处理版本已变化，请刷新后重新准备"
		case "workflow_source_changed":
			code, message = body.Code, "源图已变化，请重新准备该行"
		case "workflow_ai_input_mismatch":
			code, message = body.Code, "领取的识图作业与预处理输入不一致，请重新准备"
		}
		receipts, err := tx.Query(r.Context(), `SELECT response_body FROM ai_requests WHERE org_id=$1 AND job_id=$2::uuid AND status='settled'`, p.OrgID, body.JobID)
		if err != nil {
			return err
		}
		var bodies [][]byte
		for receipts.Next() {
			var raw []byte
			if err = receipts.Scan(&raw); err != nil {
				receipts.Close()
				return err
			}
			bodies = append(bodies, raw)
		}
		err = receipts.Err()
		receipts.Close()
		if err != nil {
			return err
		}
		for _, raw := range bodies {
			if _, err = h.ValidateOCR(r.Context(), binding.Pin, raw); err == nil {
				return rowRefuse{409, "已有有效识别结果，请恢复回写", "ocr_recovery_required"}
			}
			var violation *ai.ContractError
			if !errors.As(err, &violation) {
				return err
			}
			code, message = "ocr_contract_violation", violation.Message
		}
		if _, err = tx.Exec(r.Context(), `SELECT public.release_execution_permit('job',$1,$2)`, body.JobID, body.Lease.Epoch); err != nil {
			return err
		}
		if err = settleMedia(r.Context(), tx, p.OrgID, body.JobID, "failed", code); err != nil {
			return err
		}
		log, _ := json.Marshal([]map[string]any{{"stage": "ai", "code": code, "message": message, "occurred_at_ms": h.clock().UnixMilli()}})
		if _, err = tx.Exec(r.Context(), `UPDATE listing_rows SET content_state='failed',payload=jsonb_set(payload,'{failureLog}',$3::jsonb),updated_by=$4,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id, string(log), p.UserID); err != nil {
			return err
		}
		row, _, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
		if err == nil {
			result = ProjectRow(row.row)
		}
		return err
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, result)
}

func (h Host) cancelRecognition(r *http.Request, tx pgx.Tx, p access.Principal, id string, runs *[]mediaRun) error {
	rows, err := tx.Query(r.Context(), `UPDATE jobs j SET cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp(),state=CASE WHEN EXISTS(SELECT 1 FROM ai_requests a WHERE a.org_id=j.org_id AND a.job_id=j.id AND a.status IN ('held','dispatching','settled','unbilled_unknown')) THEN 'uncertain' ELSE 'cancelled' END WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='ai.recognize' AND state IN ('queued','running','retry_wait','uncertain') RETURNING `+mediaRunColumns, p.OrgID, id)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		run, err := scanMediaRun(rows)
		if err != nil {
			rows.Close()
			return err
		}
		*runs = append(*runs, run)
		ids = append(ids, run.ID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err = tx.Exec(r.Context(), `SELECT public.release_execution_permit('job',$1,lease_epoch) FROM jobs WHERE org_id=$2 AND id=$1::uuid`, id, p.OrgID); err != nil {
			return err
		}
	}
	return nil
}

// ValidateOCR combines and filters tags at purchase, recovery and settle.
func (h Host) ValidateOCR(ctx context.Context, pin ai.Pin, completion []byte) (json.RawMessage, error) {
	if h.core() == nil {
		return nil, errors.New("recognition core unavailable")
	}
	input, err := json.Marshal(map[string]any{"profile": json.RawMessage(pin.Prompt.Content), "fixed_tags": pin.Prompt.FixedTags, "completion": json.RawMessage(completion)})
	if err != nil {
		return nil, err
	}
	parsed, err := h.core().Call(ctx, core.OpParseOCRAnswer, nil, input)
	if err != nil {
		if failure, ok := core.AsCoreError(err); ok && failure.ReasonCode != "" {
			return nil, &ai.ContractError{Message: failure.Message, ReasonCode: failure.ReasonCode, RetryClass: failure.RetryClass}
		}
		return nil, err
	}
	if h.LoadRules == nil || h.Engine == nil {
		return nil, errors.New("全局受限标签规则不可用")
	}
	rules, err := h.LoadRules(ctx)
	if err != nil {
		return nil, err
	}
	var answer ai.Answer
	if err := json.Unmarshal(parsed, &answer); err != nil {
		return nil, err
	}
	tags := append(append([]string{}, pin.Prompt.FixedTags...), answer.Tags...)
	filtered, err := h.Engine.StripForAI(ctx, tags, rules)
	if err != nil {
		return nil, err
	}
	answer.Tags = filtered.Kept
	return json.Marshal(answer)
}
