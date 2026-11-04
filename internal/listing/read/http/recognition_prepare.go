package readhttp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

const recognitionContract = ai.RecognitionContract

func recognitionFingerprint(pin ai.Pin) string {
	pin.PinnedRevision = 0
	pin.PreparationOperation = ""
	raw, _ := json.Marshal(pin)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func recognitionInput(ctx context.Context, tx pgx.Tx, row storedScan, card []byte, routing ai.Routing) (ai.Pin, error) {
	var source struct {
		Source struct {
			SHA string `json:"sha256"`
		} `json:"source"`
	}
	var config struct {
		Product   string          `json:"supplierProductId"`
		PromptID  string          `json:"aiPromptId"`
		PromptSHA string          `json:"aiPromptSha256"`
		Category  int64           `json:"descriptionCategoryId"`
		Type      int64           `json:"typeId"`
		Policy    json.RawMessage `json:"aiFieldPolicy"`
	}
	if json.Unmarshal(row.row.Payload, &source) != nil || json.Unmarshal(card, &config) != nil {
		return ai.Pin{}, rowRefuse{422, "识别输入无效", "invalid_recognition_input"}
	}
	sha, ok := hex64(source.Source.SHA)
	if !ok {
		return ai.Pin{}, rowRefuse{422, "请先选择原图", "missing_source"}
	}
	pin := ai.Pin{Executor: "browser", PinnedRevision: row.row.Revision, SourceSHA256: sha, Contract: recognitionContract, Prompt: ai.Prompt{TemplateSHA256: ai.VisualPromptSHA256()}, Routing: routing}
	if config.Product != "" {
		pin.FieldPolicy = config.Policy
		facts, err := loadSupplier((&http.Request{}).WithContext(ctx), tx, config.Product, time.Now().UnixMilli())
		if err != nil {
			return pin, err
		}
		if facts.missingProduct || facts.missingConfig || facts.denial != "" || facts.category != config.Category || facts.typeID != config.Type {
			return pin, rowRefuse{422, "供应商商品或类目已变化，不能开始识别", "invalid_prompt"}
		}
		var tags []byte
		err = tx.QueryRow(ctx, `SELECT prompt_text,fixed_tags FROM supplier_ozon_configs WHERE product_id=$1 FOR SHARE`, config.Product).Scan(&pin.Prompt.Content, &tags)
		if err != nil {
			return pin, err
		}
		if _, err := ai.ParseProductProfile(pin.Prompt.Content); err != nil {
			return pin, rowRefuse{422, err.Error(), "invalid_profile"}
		}
		if json.Unmarshal(tags, &pin.Prompt.FixedTags) != nil || len(pin.Prompt.FixedTags) == 0 {
			return pin, rowRefuse{422, "商品固定标签无效", "invalid_prompt"}
		}
		sum := sha256.Sum256([]byte(pin.Prompt.Content))
		pin.Prompt.SHA256 = hex.EncodeToString(sum[:])
		pin.Prompt.ID = "supplier:" + config.Product
		return pin, nil
	}
	if config.PromptID == "" {
		return pin, rowRefuse{422, "请先绑定商品事实", "missing_prompt"}
	}
	var tags []byte
	err := tx.QueryRow(ctx, `SELECT prompt_id,content,fixed_tags FROM category_prompts WHERE prompt_id=$1 AND description_category_id=$2 AND type_id=$3 FOR SHARE`, config.PromptID, config.Category, config.Type).Scan(&pin.Prompt.ID, &pin.Prompt.Content, &tags)
	if errors.Is(err, pgx.ErrNoRows) {
		return pin, rowRefuse{422, "商品事实不存在或类目已变化", "missing_prompt"}
	}
	if err != nil {
		return pin, err
	}
	sum := sha256.Sum256([]byte(pin.Prompt.Content))
	pin.Prompt.SHA256 = hex.EncodeToString(sum[:])
	if config.PromptSHA != pin.Prompt.SHA256 || strings.TrimSpace(pin.Prompt.Content) == "" || len(pin.Prompt.Content) > 64*1024 || json.Unmarshal(tags, &pin.Prompt.FixedTags) != nil || len(pin.Prompt.FixedTags) < 1 || len(pin.Prompt.FixedTags) > 30 {
		return pin, rowRefuse{422, "商品事实或固定标签已变化，请重新绑定", "invalid_prompt"}
	}
	if _, err := ai.ParseProductProfile(pin.Prompt.Content); err != nil {
		return pin, rowRefuse{422, err.Error(), "invalid_profile"}
	}
	return pin, nil
}

func (h Host) prepareRecognition(w http.ResponseWriter, r *http.Request, p access.Principal, id, operation, renderer, command string) {
	var routing ai.Routing
	if h.Queue.EnqueueOn == nil {
		mediaError(w, rowRefuse{503, "准备任务队列暂不可用", "internal"})
		return
	}
	var modelErr error
	if h.RecognitionModels == nil {
		modelErr = rowRefuse{422, "请先配置识别模型", "missing_model"}
	} else {
		models, preferred, err := h.RecognitionModels(r.Context())
		if err != nil {
			modelErr = rowRefuse{422, "请先配置识别模型", "missing_model"}
		} else {
			routing.Primary = preferred
			known := map[string]bool{}
			for _, model := range models {
				known[model] = true
			}
			if !known[routing.Primary] {
				modelErr = rowRefuse{422, "系统默认识图模型不可用，请联系管理员配置", "missing_model"}
			}
		}
	}
	runs := []mediaRun{}
	issues := []map[string]any{}
	outcome := "running"
	aiReady := false
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		if command != "" {
			if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('listing-media-command:'||$1::bigint::text||':'||$2::text,0))`, p.OrgID, command); err != nil {
				return err
			}
		}
		row, card, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		if command != "" {
			prior, err := h.replayPreparationCommand(r.Context(), tx, p, row, card, operation, renderer, command)
			if err != nil {
				return err
			}
			if len(prior) > 0 {
				runs = prior
				outcome = "waiting"
				for _, run := range prior {
					if run.State == "failed" || run.State == "cancelled" {
						outcome = "needs_review"
					}
				}
				if operation == "recognize" && len(prior) == 1 && prior[0].State == "succeeded" {
					outcome = "prepared"
				}
				if operation == "prepare" && row.row.Content == "ready" && row.row.Media == "ready" {
					outcome = "prepared"
				}
				return nil
			}
		}
		pin, err := recognitionInput(r.Context(), tx, row, card, routing)
		if modelErr != nil {
			err = modelErr
		}
		if err != nil {
			if operation == "recognize" {
				return err
			}
			var refused rowRefuse
			if !errors.As(err, &refused) {
				return err
			}
			issues = append(issues, map[string]any{"kind": "ai.recognize", "blockers": []string{refused.code}, "message": refused.message})
		} else {
			pin.PreparationOperation = operation
			run, err := h.enqueueRecognition(r.Context(), tx, p, row, pin, command)
			if err != nil {
				var refused rowRefuse
				if operation != "prepare" || !errors.As(err, &refused) {
					return err
				}
				issues = append(issues, map[string]any{"kind": "ai.recognize", "blockers": []string{refused.code}, "message": refused.message})
			} else if run.State == "succeeded" {
				aiReady = true
			} else {
				runs = append(runs, run)
			}
		}
		if operation == "prepare" {
			mediaPin, err := mediaInput(row, card, renderer)
			if err != nil {
				var refused rowRefuse
				if !errors.As(err, &refused) {
					return err
				}
				issues = append(issues, map[string]any{"kind": "media.render", "blockers": []string{refused.code}, "message": refused.message})
			} else {
				mediaPin.PreparationOperation = operation
				kind, state := "media.render", "processing"
				payload, err := decodeMediaPayload(row.row.Payload)
				if err != nil {
					return err
				}
				if payload.Evidence.matches(mediaPin) && len(payload.Media.Images) > 0 && payload.Evidence.ManifestDigest != "" {
					kind, state = "media.upload", "uploading"
					mediaPin.Manifest = payload.Evidence.Manifest
					mediaPin.ManifestDigest = payload.Evidence.ManifestDigest
				}
				if row.row.Media == "ready" && kind == "media.upload" { /* Current uploaded evidence is already complete. */
				} else {
					prior, err := scanMediaRun(tx.QueryRow(r.Context(), `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind=$3 AND input_fingerprint=$4 AND (($5='' AND state IN ('queued','running','retry_wait')) OR (command_id=$5 AND $5<>'')) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, p.OrgID, id, kind, pinFingerprint(mediaPin), command))
					if err == nil {
						runs = append(runs, prior)
					} else if !errors.Is(err, pgx.ErrNoRows) {
						return err
					} else {
						if _, err = tx.Exec(r.Context(), `UPDATE jobs SET state='cancelled',cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind IN ('media.render','media.upload') AND state IN ('queued','running','retry_wait')`, p.OrgID, id); err != nil {
							return err
						}
						raw, _ := json.Marshal(mediaPin)
						run, err := h.enqueuePrepared(r.Context(), tx, p, row, kind, raw, pinFingerprint(mediaPin), command)
						if err != nil {
							return err
						}
						runs = append(runs, run)
						if _, err = tx.Exec(r.Context(), `UPDATE listing_rows SET media_state=$3,updated_by=$4,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id, state, p.UserID); err != nil {
							return err
						}
					}
				}
			}
		}
		if len(runs) == 0 {
			outcome = "needs_review"
			if len(issues) == 0 && aiReady && (operation == "recognize" || row.row.Media == "ready") {
				outcome = "prepared"
			}
		}
		return nil
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, map[string]any{"jobs": runs, "outcome": outcome, "issues": issues})
}
func (h Host) enqueueRecognition(ctx context.Context, tx pgx.Tx, p access.Principal, row storedScan, pin ai.Pin, command string) (mediaRun, error) {
	fingerprint := recognitionFingerprint(pin)
	if command != "" {
		var count int
		var match bool
		err := tx.QueryRow(ctx, `SELECT count(*),COALESCE(bool_and(aggregate_id=$3::uuid AND (kind<>'ai.recognize' OR input_fingerprint=$4)),true) FROM jobs WHERE org_id=$1 AND command_id=$2`, p.OrgID, command, row.row.ID, fingerprint).Scan(&count, &match)
		if err != nil {
			return mediaRun{}, err
		}
		if count > 0 && !match {
			return mediaRun{}, rowRefuse{409, "该命令已用于不同的准备输入", "conflict"}
		}
	}
	// A new browser command must not mint a second paid recognition for the
	// result already applied to this row under the same frozen input.
	if requestID := recognitionRequestID(row.row.Payload); requestID != "" {
		prior, err := scanMediaRun(tx.QueryRow(ctx, `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='ai.recognize' AND input_fingerprint=$3 AND state='succeeded' AND EXISTS(SELECT 1 FROM ai_requests a WHERE a.org_id=jobs.org_id AND a.job_id=jobs.id AND a.public_id=$4 AND a.operation='ocr' AND a.status='settled' AND a.binding_status='bound' AND a.input_fingerprint=jobs.input_fingerprint) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, p.OrgID, row.row.ID, fingerprint, requestID))
		if err == nil {
			_, err = markRecognitionReady(ctx, tx, p, row)
			return prior, err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return mediaRun{}, err
		}
	} else if recovered, found, err := h.recoverFailedRecognition(ctx, tx, p, row, pin); err != nil || found {
		return recovered, err
	}
	prior, err := scanMediaRun(tx.QueryRow(ctx, `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='ai.recognize' AND input_fingerprint=$3 AND (($4='' AND state IN ('queued','running','retry_wait','uncertain')) OR (command_id=$4 AND $4<>'')) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, p.OrgID, row.row.ID, fingerprint, command))
	if err == nil {
		return prior, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return mediaRun{}, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs j JOIN ai_requests a ON a.org_id=j.org_id AND a.job_id=j.id WHERE j.org_id=$1 AND j.aggregate_id=$2::uuid AND j.kind='ai.recognize' AND j.state IN ('queued','running','retry_wait','uncertain') AND a.status IN ('held','dispatching','settled','unbilled_unknown'))`, p.OrgID, row.row.ID).Scan(&active); err != nil {
		return mediaRun{}, err
	}
	if active {
		return mediaRun{}, rowRefuse{409, "已有识别付款待恢复，请先恢复该任务", "ocr_recovery_required"}
	}
	if _, err = tx.Exec(ctx, `UPDATE jobs SET state='cancelled',cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='ai.recognize' AND state IN ('queued','running','retry_wait','uncertain')`, p.OrgID, row.row.ID); err != nil {
		return mediaRun{}, err
	}
	raw, _ := json.Marshal(pin)
	return h.enqueuePrepared(ctx, tx, p, row, "ai.recognize", raw, fingerprint, command)
}

func (h Host) recoverFailedRecognition(ctx context.Context, tx pgx.Tx, p access.Principal, row storedScan, pin ai.Pin) (mediaRun, bool, error) {
	var jobID, requestID, model string
	var payload, completion []byte
	var epoch, charged int64
	fingerprint := recognitionFingerprint(pin)
	err := tx.QueryRow(ctx, `SELECT j.id::text,j.payload,j.lease_epoch,a.public_id,a.response_body,a.model,a.charged_microfen
	 FROM jobs j JOIN ai_requests a ON a.org_id=j.org_id AND a.job_id=j.id
	 WHERE j.org_id=$1 AND j.aggregate_id=$2::uuid AND j.kind='ai.recognize' AND j.state='failed'
	 AND j.input_fingerprint=$3 AND j.submitter_user_id=$4 AND a.user_id=$4
	 AND a.operation='ocr' AND a.status='settled' AND a.binding_status='bound'
	 AND a.input_fingerprint=j.input_fingerprint AND COALESCE(a.binding_hash,'')<>''
	 ORDER BY a.id DESC LIMIT 1 FOR UPDATE OF j`, p.OrgID, row.row.ID, fingerprint, p.UserID).Scan(&jobID, &payload, &epoch, &requestID, &completion, &model, &charged)
	if errors.Is(err, pgx.ErrNoRows) {
		return mediaRun{}, false, nil
	}
	if err != nil {
		return mediaRun{}, false, err
	}
	var stored ai.Pin
	if json.Unmarshal(payload, &stored) != nil || recognitionFingerprint(stored) != fingerprint {
		return mediaRun{}, false, rowRefuse{409, "原识图输入已变化，不能恢复回执", "conflict"}
	}
	if _, err := h.ValidateOCR(ctx, stored, completion); err != nil {
		var violation *ai.ContractError
		if errors.As(err, &violation) {
			return mediaRun{}, false, nil
		}
		return mediaRun{}, false, err
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='ai.recognize' AND state IN ('queued','running','retry_wait','uncertain'))`, p.OrgID, row.row.ID).Scan(&active); err != nil {
		return mediaRun{}, false, err
	}
	if active {
		return mediaRun{}, false, rowRefuse{409, "已有识图任务正在处理，请先完成或停止后恢复", "ocr_recovery_required"}
	}
	// The bound receipt proves this actor's purchase; recovery never reopens its expired lease.
	binding := ai.Binding{RowID: row.row.ID, Pin: stored, Fingerprint: fingerprint, Lease: ai.Lease{Epoch: epoch}}
	if _, err := h.applyRecognitionReceipt(ctx, tx, p, jobID, binding, completion, requestID, model, charged); err != nil {
		return mediaRun{}, false, err
	}
	run, err := loadMediaRun(ctx, tx, p.OrgID, jobID)
	return run, true, err
}
func (h Host) enqueuePrepared(ctx context.Context, tx pgx.Tx, p access.Principal, row storedScan, kind string, payload []byte, fingerprint, command string) (mediaRun, error) {
	id := uuid.New()
	now := h.clock()
	queued, err := h.Queue.EnqueueOn(ctx, tx, []queue.NewJob{{ID: id, OrgID: p.OrgID, Kind: kind, AggregateType: "listing_row", AggregateID: uuid.MustParse(row.row.ID), InputRevision: row.row.Revision, IdempotencyKey: "prepare:" + id.String(), Payload: payload, SubmitterUserID: p.UserID, MaxAttempts: 1, Priority: 100, RunAt: now, CreatedAt: now}}, 0)
	if err != nil {
		return mediaRun{}, err
	}
	if len(queued) != 1 {
		return mediaRun{}, errors.New("queue returned no preparation job")
	}
	if _, err = tx.Exec(ctx, `UPDATE jobs SET command_id=NULLIF($3,''),input_fingerprint=$4 WHERE org_id=$1 AND id=$2`, p.OrgID, queued[0].ID, command, fingerprint); err != nil {
		return mediaRun{}, err
	}
	return loadMediaRun(ctx, tx, p.OrgID, queued[0].ID.String())
}

// A command replays its original rails; changing only the template must not
// quietly attach fresh media work to a previously purchased recognition.
func (h Host) replayPreparationCommand(ctx context.Context, tx pgx.Tx, p access.Principal, row storedScan, card []byte, operation, renderer, command string) ([]mediaRun, error) {
	rows, err := tx.Query(ctx, `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND command_id=$2 ORDER BY created_at,id FOR UPDATE`, p.OrgID, command)
	if err != nil {
		return nil, err
	}
	runs := []mediaRun{}
	for rows.Next() {
		run, err := scanMediaRun(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		runs = append(runs, run)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	changed := rowRefuse{409, "该命令已用于不同的准备操作或输入", "conflict"}
	for _, run := range runs {
		if run.AggregateID != row.row.ID {
			return nil, changed
		}
		switch run.Kind {
		case "ai.recognize":
			var prior ai.Pin
			if json.Unmarshal(run.Payload, &prior) != nil || prior.PreparationOperation != operation {
				return nil, changed
			}
			current, err := recognitionInput(ctx, tx, row, card, prior.Routing)
			if err != nil {
				return nil, changed
			}
			if recognitionFingerprint(current) != run.fingerprint {
				return nil, changed
			}
		case "media.render", "media.upload":
			var prior mediaPin
			if json.Unmarshal(run.Payload, &prior) != nil || prior.PreparationOperation != operation {
				return nil, changed
			}
			current, err := mediaInput(row, card, renderer)
			if err != nil {
				return nil, changed
			}
			if run.Kind == "media.upload" {
				payload, err := decodeMediaPayload(row.row.Payload)
				if err != nil {
					return nil, err
				}
				current.ManifestDigest = payload.Evidence.ManifestDigest
				current.Manifest = payload.Evidence.Manifest
			}
			if pinFingerprint(current) != run.fingerprint {
				return nil, changed
			}
		default:
			return nil, changed
		}
	}
	return runs, nil
}
