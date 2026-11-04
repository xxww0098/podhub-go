package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	mediacontract "github.com/xxww0098/podhub-go/internal/media/contract"
)

type mediaWriteResult struct {
	Applied bool       `json:"applied"`
	Jobs    []mediaRun `json:"jobs"`
	Row     *RowView   `json:"row,omitempty"`
}
type mediaFailureLog struct {
	Stage       string  `json:"stage"`
	Code        string  `json:"code"`
	Message     string  `json:"message"`
	Remediation *string `json:"remediation,omitempty"`
	ImageIndex  *int    `json:"image_index,omitempty"`
	Occurred    int64   `json:"occurred_at_ms"`
}

func (h Host) completeMedia(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, 400, "商品行标识无效", "validation")
		return
	}
	var body struct {
		Revision  int64   `json:"expected_revision"`
		ErrorCode *string `json:"error_code"`
		State     string  `json:"media_state"`
		JobID     string  `json:"job_id"`
		Payload   struct {
			Media struct {
				Images []mediaImage `json:"images"`
			} `json:"media"`
			Evidence renderEvidence    `json:"render_evidence"`
			Failure  []mediaFailureLog `json:"failure_log"`
		} `json:"payload"`
	}
	if readMediaBody(r, &body) != nil || body.Revision < 1 {
		writeErr(w, 400, "媒体回写请求无效", "validation")
		return
	}
	if _, ok = CanonicalUUID(body.JobID); !ok {
		writeErr(w, 400, "媒体任务标识无效", "validation")
		return
	}
	if body.State != "rendered" && body.State != "failed" {
		writeErr(w, 400, "媒体状态无效", "validation")
		return
	}
	if body.State == "rendered" && !validRenderImages(body.Payload.Media.Images) {
		writeErr(w, 400, "切片尺寸、字节数或摘要无效", "validation")
		return
	}
	if body.State == "failed" {
		if len(body.Payload.Failure) == 0 || len(body.Payload.Failure) > 10 {
			writeErr(w, 400, "缺少媒体失败记录", "validation")
			return
		}
		for _, f := range body.Payload.Failure {
			if f.Stage != "media" || len(f.Code) > 128 || len(f.Message) > 2048 || f.Occurred <= 0 {
				writeErr(w, 400, "媒体失败记录无效", "validation")
				return
			}
		}
	}
	result := mediaWriteResult{Jobs: []mediaRun{}}
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		row, card, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		run, err := loadMediaRun(r.Context(), tx, p.OrgID, body.JobID)
		if err != nil {
			return err
		}
		kind := "media.render"
		if body.State == "failed" {
			kind = run.Kind
			if kind != "media.render" && kind != "media.upload" {
				return rowRefuse{409, "媒体任务类型不匹配", "conflict"}
			}
		}
		pin, err := checkMediaRun(run, row, card, kind)
		if err != nil {
			return err
		}
		if row.row.Revision != body.Revision {
			return nil
		}
		var payload map[string]json.RawMessage
		if json.Unmarshal(row.row.Payload, &payload) != nil {
			return errors.New("invalid row payload")
		}
		if body.State == "failed" {
			if run.State == "succeeded" {
				return rowRefuse{409, "已完成的任务不能写为失败", "conflict"}
			}
			payload["failureLog"], err = json.Marshal(body.Payload.Failure)
			if err != nil {
				return err
			}
			if err = settleMedia(r.Context(), tx, p.OrgID, run.ID, "failed", body.Payload.Failure[0].Code); err != nil {
				return err
			}
		} else {
			if !body.Payload.Evidence.matches(pin) {
				return rowRefuse{409, "切片证据与固定输入不一致", "conflict"}
			}
			if h.core() == nil {
				return rowRefuse{503, "渲染校验暂不可用", "internal"}
			}
			input, err := json.Marshal(map[string]any{"images": body.Payload.Media.Images, "rendererManifest": body.Payload.Evidence.Manifest})
			if err != nil {
				return err
			}
			out, err := h.core().Call(r.Context(), core.OpRecordRender, nil, input)
			if err != nil {
				status, message, code := refuseCore(err)
				return rowRefuse{status, message, code}
			}
			var record struct {
				Images   []mediaImage    `json:"images"`
				Manifest json.RawMessage `json:"manifest"`
				Digest   string          `json:"manifestDigest"`
			}
			if json.Unmarshal(out, &record) != nil || record.Digest == "" || len(record.Images) != len(body.Payload.Media.Images) || len(record.Manifest) == 0 {
				return errors.New("invalid render record")
			}
			if run.State == "succeeded" {
				current, e := decodeMediaPayload(row.row.Payload)
				if e != nil {
					return e
				}
				if current.Evidence.ManifestDigest != record.Digest {
					return rowRefuse{409, "任务已保存不同的切片清单", "conflict"}
				}
				view := ProjectRow(row.row)
				result.Applied = true
				result.Row = &view
				return nil
			}
			evidence := body.Payload.Evidence
			evidence.ManifestDigest = record.Digest
			evidence.Manifest = record.Manifest
			evidence.SliceCount = len(record.Images)
			payload["renderEvidence"], err = json.Marshal(evidence)
			if err != nil {
				return err
			}
			media := map[string]json.RawMessage{}
			_ = json.Unmarshal(payload["media"], &media)
			media["images"], err = json.Marshal(record.Images)
			if err != nil {
				return err
			}
			payload["media"], err = json.Marshal(media)
			if err != nil {
				return err
			}
			payload["failureLog"] = json.RawMessage(`[]`)
			if err = settleMedia(r.Context(), tx, p.OrgID, run.ID, "succeeded", ""); err != nil {
				return err
			}
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		saved, err := h.saveMediaRow(r.Context(), tx, p, id, raw, body.State, false, "", "")
		if err != nil {
			return err
		}
		view := ProjectRow(saved.row)
		result.Applied = true
		result.Row = &view
		return nil
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, result)
}

type mediaImageInput struct {
	Index   int    `json:"index"`
	Key     string `json:"object_key"`
	Account string `json:"account_id"`
}
type mediaImageResult struct {
	Applied         bool     `json:"applied"`
	Index           int      `json:"index"`
	Phase           string   `json:"phase"`
	Completed       int      `json:"completed"`
	Total           int      `json:"total"`
	MediaState      string   `json:"media_state"`
	ViewRevision    int64    `json:"view_revision"`
	Account         string   `json:"account_id,omitempty"`
	Key             string   `json:"object_key,omitempty"`
	URL             string   `json:"public_url,omitempty"`
	StorageRevision int64    `json:"storage_revision,omitempty"`
	Row             *RowView `json:"row,omitempty"`
}

func (h Host) completeImages(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobID  string            `json:"job_id"`
		Images []mediaImageInput `json:"images"`
	}
	if readMediaBody(r, &body) != nil {
		writeErr(w, 400, "图片确认请求无效", "validation")
		return
	}
	h.completeMediaImages(w, r, body.JobID, body.Images, false)
}
func (h Host) completeImage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobID   string `json:"job_id"`
		Key     string `json:"object_key"`
		Account string `json:"account_id"`
	}
	index, err := strconv.Atoi(chi.URLParam(r, "index"))
	if err != nil || readMediaBody(r, &body) != nil {
		writeErr(w, 400, "图片确认请求无效", "validation")
		return
	}
	h.completeMediaImages(w, r, body.JobID, []mediaImageInput{{Index: index, Key: body.Key, Account: body.Account}}, true)
}
func (h Host) completeMediaImages(w http.ResponseWriter, r *http.Request, jobID string, inputs []mediaImageInput, single bool) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, 400, "商品行标识无效", "validation")
		return
	}
	if _, ok = CanonicalUUID(jobID); !ok || len(inputs) == 0 || len(inputs) > 128 {
		writeErr(w, 400, "图片确认请求无效", "validation")
		return
	}
	seen := map[int]bool{}
	for _, input := range inputs {
		if input.Index < 0 || input.Key == "" || input.Account == "" || seen[input.Index] {
			writeErr(w, 400, "图片确认请求无效", "validation")
			return
		}
		seen[input.Index] = true
	}
	if h.Transit == nil {
		writeErr(w, 503, "图片存储暂不可用", "internal")
		return
	}
	results := make([]mediaImageResult, len(inputs))
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		transit, err := h.Transit(r.Context(), tx, p)
		if err != nil {
			return err
		}
		if transit == nil || transit.PublicURL == nil {
			return rowRefuse{503, "切片 R2 尚未配置", "missing_media_account"}
		}
		row, card, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		run, err := loadMediaRun(r.Context(), tx, p.OrgID, jobID)
		if err != nil {
			return err
		}
		pin, err := checkMediaRun(run, row, card, "media.upload")
		if err != nil {
			return err
		}
		payload, err := decodeMediaPayload(row.row.Payload)
		if err != nil {
			return err
		}
		if !payload.Evidence.matches(pin) || pin.ManifestDigest == "" || payload.Evidence.ManifestDigest != pin.ManifestDigest {
			return rowRefuse{409, "切片清单已变化，请重新准备", "conflict"}
		}
		var manifest struct {
			Images []mediaImage `json:"images"`
		}
		if json.Unmarshal(pin.Manifest, &manifest) != nil || len(manifest.Images) == 0 || len(manifest.Images) != len(payload.Media.Images) {
			return rowRefuse{409, "切片清单不可用，请重新切片", "conflict"}
		}
		for i, image := range payload.Media.Images {
			if !sameImage(image, manifest.Images[i]) {
				return rowRefuse{409, "切片清单已变化，请重新准备", "conflict"}
			}
		}
		revisions := make(map[int]int64, len(inputs))
		for _, input := range inputs {
			if input.Index >= len(payload.Media.Images) {
				return rowRefuse{409, "图片回执不属于当前存储或切片", "media_confirmation_required"}
			}
			image := &payload.Media.Images[input.Index]
			if run.State == "succeeded" && (image.ObjectKey == nil || *image.ObjectKey != input.Key || image.AccountID == nil || *image.AccountID != input.Account) {
				return rowRefuse{409, "任务已保存不同的图片回执", "conflict"}
			}
			url, revision, err := h.verifyMediaLease(r, tx, p.OrgID, transit, *image, input.Key, input.Account)
			if err != nil {
				return err
			}
			revisions[input.Index] = revision
			image.Phase = "public_ready"
			image.ObjectKey = &input.Key
			image.AccountID = &input.Account
			image.PublicURL = &url
			image.ErrorCode = nil
		}
		completed := 0
		for _, image := range payload.Media.Images {
			if image.Phase == "public_ready" {
				completed++
			}
		}
		final := completed == len(payload.Media.Images)
		// Recheck every earlier receipt before promoting the whole row. A partial
		// callback never borrows readiness from a deleted or expired receipt.
		if final {
			for _, image := range payload.Media.Images {
				if image.ObjectKey == nil || image.AccountID == nil {
					return rowRefuse{409, "缺少图片回执", "media_confirmation_required"}
				}
				url, _, err := h.verifyMediaLease(r, tx, p.OrgID, transit, image, *image.ObjectKey, *image.AccountID)
				if err != nil {
					return err
				}
				if image.PublicURL == nil || *image.PublicURL != url {
					return rowRefuse{409, "图片公开地址已变化", "media_confirmation_required"}
				}
			}
		}
		saved := row
		if run.State != "succeeded" {
			var root map[string]json.RawMessage
			_ = json.Unmarshal(row.row.Payload, &root)
			var media map[string]json.RawMessage
			_ = json.Unmarshal(root["media"], &media)
			if media == nil {
				media = map[string]json.RawMessage{}
			}
			media["images"], err = json.Marshal(payload.Media.Images)
			if err != nil {
				return err
			}
			root["media"], err = json.Marshal(media)
			if err != nil {
				return err
			}
			raw, err := json.Marshal(root)
			if err != nil {
				return err
			}
			state, validation, content := "uploading", row.row.Validation, row.row.Content
			if final {
				if h.core() == nil {
					return rowRefuse{503, "上架校验暂不可用", "internal"}
				}
				schema, _, err := h.schemaFor(r, tx, card)
				if err != nil {
					return err
				}
				body, err := json.Marshal(map[string]any{"card": json.RawMessage(card), "row": json.RawMessage(raw), "nowMs": h.clock().UnixMilli()})
				if err != nil {
					return err
				}
				output, err := h.core().Call(r.Context(), core.OpRecordUpload, schema, body)
				if err != nil {
					status, message, code := refuseCore(err)
					return rowRefuse{status, message, code}
				}
				edited, err := decodeRowEdit(output)
				if err != nil {
					return err
				}
				raw = edited.Row
				validation = factState(edited.Fact)
				var verdict struct {
					Ready bool `json:"contentReady"`
				}
				if json.Unmarshal(output, &verdict) != nil {
					return errors.New("invalid upload verdict")
				}
				if verdict.Ready {
					content = "ready"
				}
				state = "ready"
				if err = settleMedia(r.Context(), tx, p.OrgID, run.ID, "succeeded", ""); err != nil {
					return err
				}
			}
			saved, err = h.saveMediaRow(r.Context(), tx, p, id, raw, state, final, validation, content)
			if err != nil {
				return err
			}
		} else if !final || row.row.Media != "ready" {
			return rowRefuse{409, "媒体任务结果已失效", "conflict"}
		}
		for i, input := range inputs {
			image := payload.Media.Images[input.Index]
			results[i] = mediaImageResult{Applied: true, Index: input.Index, Phase: "public_ready", Completed: completed, Total: len(payload.Media.Images), MediaState: saved.row.Media, ViewRevision: saved.row.ViewRevision, Account: *image.AccountID, Key: *image.ObjectKey, URL: *image.PublicURL, StorageRevision: revisions[input.Index]}
		}
		if final {
			view := ProjectRow(saved.row)
			results[len(results)-1].Row = &view
		}
		return nil
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	if single {
		mediaData(w, results[0])
	} else {
		mediaData(w, map[string]any{"items": results, "total": len(results)})
	}
}
func sameImage(a, b mediaImage) bool {
	return a.Index == b.Index && a.FileName == b.FileName && a.ContentHash == b.ContentHash && a.Group == b.Group && a.Width == b.Width && a.Height == b.Height && a.Bytes == b.Bytes
}
func (h Host) verifyMediaLease(r *http.Request, tx pgx.Tx, org int64, transit *TransitStorage, image mediaImage, key, account string) (string, int64, error) {
	expectedRevision := transit.StorageRevision
	if account != transit.AccountID {
		prefix, err := mediacontract.SlicePrefix(account)
		if err != nil || !strings.HasPrefix(key, prefix+"uploads/") {
			return "", 0, rowRefuse{409, "图片存储配置已变化，请重新确认", "media_confirmation_required"}
		}
		expectedRevision = -1
	}
	digest, ok := hex64(image.ContentHash)
	if !ok {
		return "", 0, rowRefuse{409, "图片摘要无效", "media_confirmation_required"}
	}
	var public string
	var revision int64
	err := tx.QueryRow(r.Context(), `SELECT l.public_url,l.storage_revision FROM media_object_leases l JOIN organizations o ON o.id=l.org_id AND o.uuid=l.workspace_uuid
 WHERE l.org_id=$1 AND l.object_key=$2 AND l.content_hash=$3 AND l.media_account_id=$4 AND ($5::bigint<0 OR l.storage_revision=$5)
 AND l.verified_byte_length=$6 AND l.verified_width=$7 AND l.verified_height=$8
 AND l.verification_status='verified' AND l.verified_at IS NOT NULL AND l.public_ready_at IS NOT NULL
 AND l.expires_at>clock_timestamp() AND l.retired_at IS NULL AND l.deleted_at IS NULL AND l.gc_claim_token IS NULL
 FOR SHARE OF l`, org, key, digest, account, expectedRevision, image.Bytes, image.Width, image.Height).Scan(&public, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, rowRefuse{409, "图片尚未完成存储校验，请重新上传确认", "media_confirmation_required"}
	}
	if err != nil {
		return "", 0, err
	}
	if public == "" || (account == transit.AccountID && public != transit.PublicURL(key)) {
		return "", 0, rowRefuse{409, "图片公开地址已变化", "media_confirmation_required"}
	}
	return public, revision, nil
}
