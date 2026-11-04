package readhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

func readMediaBody(r *http.Request, dst any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, (2<<20)+1))
	if err != nil || len(raw) > 2<<20 {
		return errors.New("request too large")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err = dec.Decode(dst); err != nil {
		return err
	}
	if err = dec.Decode(new(any)); err != io.EOF {
		return errors.New("trailing request")
	}
	return nil
}
func mediaData(w http.ResponseWriter, data any) { jsonwire.Write(w, 200, map[string]any{"data": data}) }
func validCommand(id string) bool {
	if len(id) > 128 {
		return false
	}
	for _, r := range id {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func (h Host) prepareMedia(w http.ResponseWriter, r *http.Request) {
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
		Operation string `json:"operation"`
		Renderer  string `json:"renderer_contract_version"`
		Command   string `json:"command_id"`
	}
	if readMediaBody(r, &body) != nil || !validCommand(body.Command) {
		writeErr(w, 400, "准备请求无效", "validation")
		return
	}
	for _, name := range []string{"X-Automation-Operation", "X-Automation-Runtime", "X-Automation-Claim-Epoch"} {
		if r.Header.Get(name) != "" {
			writeErr(w, 501, "自动化准备尚未接入", "not_replayable")
			return
		}
	}
	if body.Operation == "recognize" || body.Operation == "prepare" {
		h.prepareRecognition(w, r, p, id, body.Operation, body.Renderer, body.Command)
		return
	}
	if body.Operation != "slice" && body.Operation != "upload" {
		writeErr(w, 400, "准备操作无效", "validation")
		return
	}
	if h.Queue.EnqueueOn == nil {
		writeErr(w, 503, "准备任务队列暂不可用", "internal")
		return
	}
	runs := []mediaRun{}
	outcome := "running"
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		if body.Command != "" {
			if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('listing-media-command:'||$1::bigint::text||':'||$2::text,0))`, p.OrgID, body.Command); err != nil {
				return err
			}
		}
		row, card, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		pin, err := mediaInput(row, card, body.Renderer)
		if err != nil {
			return err
		}
		pin.PreparationOperation = body.Operation
		kind, state := "media.render", "processing"
		if body.Operation == "upload" {
			kind, state = "media.upload", "uploading"
			if h.Transit == nil {
				return rowRefuse{422, "尚未配置图片存储", "missing_media_account"}
			}
			transit, err := h.Transit(r.Context(), tx, p)
			if err != nil {
				return err
			}
			if transit == nil || transit.PublicURL == nil {
				return rowRefuse{422, "尚未配置切片 R2", "missing_media_account"}
			}
			if row.row.Media == "processing" {
				return rowRefuse{409, "切片任务尚未完成", "conflict"}
			}
			payload, err := decodeMediaPayload(row.row.Payload)
			if err != nil {
				return err
			}
			if !payload.Evidence.matches(pin) || len(payload.Media.Images) == 0 || payload.Evidence.ManifestDigest == "" || len(payload.Evidence.Manifest) == 0 {
				return rowRefuse{422, "请先完成当前原图和模板的切片", "render_required"}
			}
			pin.ManifestDigest = payload.Evidence.ManifestDigest
			pin.Manifest = payload.Evidence.Manifest
		}
		fingerprint := pinFingerprint(pin)
		if body.Command != "" {
			prior, err := scanMediaRun(tx.QueryRow(r.Context(), `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND command_id=$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE`, p.OrgID, body.Command))
			if err == nil {
				var priorPin mediaPin
				_ = json.Unmarshal(prior.Payload, &priorPin)
				if prior.Kind != kind || prior.AggregateID != id || prior.fingerprint != fingerprint || priorPin.PreparationOperation != body.Operation {
					return rowRefuse{409, "该命令已用于不同的准备输入", "conflict"}
				}
				runs = append(runs, prior)
				outcome = runOutcome(prior)
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		prior, err := scanMediaRun(tx.QueryRow(r.Context(), `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND aggregate_type='listing_row' AND aggregate_id=$2::uuid AND kind=$3 AND state IN ('queued','running','retry_wait') AND cancel_requested_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE`, p.OrgID, id, kind))
		if err == nil && prior.fingerprint == fingerprint && body.Command == "" {
			runs = append(runs, prior)
			outcome = "waiting"
			return nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// One current media rail per row. A render replaces both older rails; an
		// upload joins only a render that has already committed its manifest.
		if _, err = tx.Exec(r.Context(), `UPDATE jobs SET state='cancelled',cancel_requested_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL
   WHERE org_id=$1 AND aggregate_type='listing_row' AND aggregate_id=$2::uuid AND kind IN ('media.render','media.upload') AND state IN ('queued','running','retry_wait')`, p.OrgID, id); err != nil {
			return err
		}
		raw, err := json.Marshal(pin)
		if err != nil {
			return err
		}
		jobID := uuid.New()
		now := h.clock()
		key := "media:" + jobID.String()
		if body.Command != "" {
			key = "media-command:" + body.Command
		}
		queued, err := h.Queue.EnqueueOn(r.Context(), tx, []queue.NewJob{{ID: jobID, OrgID: p.OrgID, Kind: kind, AggregateType: "listing_row", AggregateID: uuid.MustParse(id), InputRevision: row.row.Revision, IdempotencyKey: key, Payload: raw, SubmitterUserID: p.UserID, MaxAttempts: 1, Priority: 100, RunAt: now, CreatedAt: now}}, 0)
		if err != nil {
			return err
		}
		if len(queued) != 1 {
			return errors.New("queue returned no media job")
		}
		if _, err = tx.Exec(r.Context(), `UPDATE jobs SET command_id=NULLIF($3,''),input_fingerprint=$4 WHERE org_id=$1 AND id=$2`, p.OrgID, queued[0].ID, body.Command, fingerprint); err != nil {
			return err
		}
		if _, err = tx.Exec(r.Context(), `UPDATE listing_rows SET media_state=$3,updated_by=$4,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id, state, p.UserID); err != nil {
			return err
		}
		run, err := loadMediaRun(r.Context(), tx, p.OrgID, queued[0].ID.String())
		if err != nil {
			return err
		}
		runs = append(runs, run)
		return nil
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, map[string]any{"jobs": runs, "outcome": outcome})
}
func runOutcome(run mediaRun) string {
	switch run.State {
	case "succeeded":
		return "prepared"
	case "failed", "cancelled":
		return "needs_review"
	default:
		return "waiting"
	}
}

func (h Host) cancelMedia(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, 400, "商品行标识无效", "validation")
		return
	}
	runs := []mediaRun{}
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		row, card, err := mediaRow(r.Context(), tx, p.OrgID, p.UserID, id)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `UPDATE jobs SET state='cancelled',cancel_requested_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
   WHERE org_id=$1 AND aggregate_type='listing_row' AND aggregate_id=$2::uuid AND kind IN ('media.render','media.upload') AND state IN ('queued','running','retry_wait') RETURNING `+mediaRunColumns, p.OrgID, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			run, e := scanMediaRun(rows)
			if e != nil {
				rows.Close()
				return e
			}
			runs = append(runs, run)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		mediaCancelled := len(runs) > 0
		if err := h.cancelRecognition(r, tx, p, id, &runs); err != nil {
			return err
		}
		if mediaCancelled {
			state := "pending"
			payload, e := decodeMediaPayload(row.row.Payload)
			if e != nil {
				return e
			}
			pin, pinErr := mediaInput(row, card, payload.Evidence.Renderer)
			if pinErr == nil && len(payload.Media.Images) > 0 && payload.Evidence.matches(pin) {
				state = "rendered"
			}
			_, err = tx.Exec(r.Context(), `UPDATE listing_rows SET media_state=$3,updated_at=clock_timestamp(),updated_by=$4 WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id, state, p.UserID)
		}
		return err
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, map[string]any{"jobs": runs})
}

type mediaImage struct {
	Index       int     `json:"index"`
	FileName    string  `json:"file_name"`
	ContentHash string  `json:"content_hash"`
	Group       string  `json:"group_name"`
	Width       int64   `json:"width"`
	Height      int64   `json:"height"`
	Bytes       int64   `json:"byte_size"`
	Phase       string  `json:"phase"`
	PublicURL   *string `json:"public_url"`
	ObjectKey   *string `json:"object_key"`
	AccountID   *string `json:"account_id,omitempty"`
	ErrorCode   *string `json:"error_code"`
}
type renderEvidence struct {
	Source         string          `json:"source_sha256"`
	Template       string          `json:"template_sha256"`
	Renderer       string          `json:"renderer_contract_version"`
	ManifestDigest string          `json:"manifest_digest"`
	Manifest       json.RawMessage `json:"manifest"`
	SliceCount     int             `json:"sliceCount"`
	Degradations   []string        `json:"degradations"`
}

func (e renderEvidence) matches(pin mediaPin) bool {
	s, sok := hex64(e.Source)
	t, tok := hex64(e.Template)
	return sok && tok && s == pin.SourceSHA && t == pin.TemplateSHA && e.Renderer == pin.Renderer
}

type mediaPayload struct {
	Media struct {
		Images []mediaImage `json:"images"`
	} `json:"media"`
	Evidence renderEvidence `json:"renderEvidence"`
}

func decodeMediaPayload(raw []byte) (mediaPayload, error) {
	var p mediaPayload
	if json.Unmarshal(raw, &p) != nil {
		return p, errors.New("invalid row media payload")
	}
	return p, nil
}
func validRenderImages(images []mediaImage) bool {
	if len(images) == 0 || len(images) > 128 {
		return false
	}
	for i, img := range images {
		_, ok := hex64(img.ContentHash)
		name := strings.ToLower(img.FileName)
		if img.Index != i || !ok || img.Phase != "rendered" || img.Bytes <= 0 || img.Bytes > 20<<20 || img.Width <= 0 || img.Height <= 0 || img.Width > 64000000/img.Height || img.PublicURL != nil || img.ObjectKey != nil || img.AccountID != nil || img.ErrorCode != nil || (!strings.HasSuffix(name, ".jpg") && !strings.HasSuffix(name, ".jpeg") && !strings.HasSuffix(name, ".png")) {
			return false
		}
	}
	return true
}
