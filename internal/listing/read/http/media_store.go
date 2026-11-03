package readhttp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func (h Host) mediaTx(ctx context.Context, p access.Principal, fn func(pgx.Tx) error) error {
	if h.Pool == nil || p.TokenHash == "" {
		return rowRefuse{503, "媒体写入暂不可用", "internal"}
	}
	tx, err := tenantx.BeginApp(ctx, h.Pool.Begin, p.OrgID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	defer writer.Forget(tx)
	if _, err = tx.Exec(ctx, `SET LOCAL statement_timeout = '5s'`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout = '2s'`); err != nil {
		return err
	}
	if err = lockPreparationPrincipal(ctx, tx, p); err != nil {
		return err
	}
	if _, err = writer.Assert(ctx, tx, "recipe", writer.ProcessIdentity(), h.clock().UnixMilli(), "上架准备写入未启用"); err != nil {
		if writer.IsDisabled(err) {
			return rowRefuse{503, "上架准备写入未启用", "internal"}
		}
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func lockPreparationPrincipal(ctx context.Context, tx pgx.Tx, p access.Principal) error {
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM account_users u JOIN account_profiles profile ON profile.user_id=u.id
 JOIN account_sessions session ON session.user_id=u.id AND session.token_hash=$3
 JOIN organization_members m ON m.user_id=u.id AND m.org_id=$2 JOIN organizations o ON o.id=m.org_id
 WHERE u.id=$1 AND u.disabled_at IS NULL AND session.expires_at>clock_timestamp()
 AND m.status='active' AND NOT m.manual_disabled AND NOT m.quota_suspended
 AND m.role IN ('owner','manager','admin','member','reviewer') AND o.dissolved_at IS NULL
 FOR SHARE OF u,profile,session,m,o`, p.UserID, p.OrgID, p.TokenHash).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return rowRefuse{403, "登录或工作空间权限已变化", "forbidden"}
	}
	if err != nil {
		return err
	}
	current, err := sqlc.New(tx).ResolveAccount(ctx, p.TokenHash)
	if err != nil || current.ID != p.UserID || current.OrgID != p.OrgID {
		return rowRefuse{403, "登录或工作空间权限已变化", "forbidden"}
	}

	if _, _, allowed := access.OrgMember(access.Principal{OrgID: current.OrgID, WorkspaceRole: current.WorkspaceRole}); !allowed {
		return rowRefuse{403, "当前成员不能准备商品", "forbidden"}
	}
	return nil
}

func mediaError(w http.ResponseWriter, err error) {
	var violation *ai.ContractError
	if errors.As(err, &violation) {
		writeErr(w, 422, violation.Message, "OCR_CONTRACT_VIOLATION")
		return
	}
	var refused rowRefuse
	if errors.As(err, &refused) {
		if refused.status == 422 {
			blocker := refused.code
			switch blocker {
			case "missing_source":
				blocker = "missing_source_image"
			case "render_required":
				blocker = "missing_render_evidence"
			case "invalid_media_input":
				blocker = "inconsistent_binding"
			}
			jsonwire.Write(w, 422, map[string]any{"error": refused.message, "code": "validation", "blockers": []string{blocker}})
			return
		}
		writeErr(w, refused.status, refused.message, refused.code)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, 404, "商品行或任务不存在", "not_found")
		return
	}
	writeDB(w, err)
}

type mediaPin struct {
	PreparationOperation string `json:"prepare_operation"`
	Executor             string `json:"executor"`
	PinnedRevision       int64  `json:"pinned_revision"`
	SourceSHA            string `json:"source_sha256"`
	TemplateSHA          string `json:"psd_template_sha256"`
	Renderer             string `json:"renderer_contract_version"`
	TemplateAsset        string `json:"psd_template_asset_id"`
	CardPayload          struct {
		Product      string `json:"supplier_product_id,omitempty"`
		TemplateFile string `json:"psd_template_file_name,omitempty"`
	} `json:"card_payload"`
	ManifestDigest string          `json:"manifest_digest,omitempty"`
	Manifest       json.RawMessage `json:"manifest,omitempty"`
}

func mediaInput(row storedScan, card []byte, renderer string) (mediaPin, error) {
	var r struct {
		Source struct {
			SHA string `json:"sha256"`
		} `json:"source"`
	}
	var c struct {
		SHA     string `json:"psdTemplateSha256"`
		Asset   string `json:"psdTemplateAssetId"`
		Product string `json:"supplierProductId"`
		File    string `json:"psdTemplateFileName"`
	}
	if json.Unmarshal(row.row.Payload, &r) != nil || json.Unmarshal(card, &c) != nil {
		return mediaPin{}, rowRefuse{422, "原图或模板信息无效", "invalid_media_input"}
	}
	source, ok := hex64(r.Source.SHA)
	if !ok {
		return mediaPin{}, rowRefuse{422, "缺少原图摘要，请重新选择原图", "missing_source"}
	}
	template, ok := hex64(c.SHA)
	if !ok {
		return mediaPin{}, rowRefuse{422, "请先绑定已验证的 PSD 模板", "missing_template"}
	}
	if renderer != "browser-wasm-v2" {
		return mediaPin{}, rowRefuse{422, "渲染版本不可用，请刷新页面", "missing_renderer_contract"}
	}
	pin := mediaPin{Executor: "browser", PinnedRevision: row.row.Revision, SourceSHA: source, TemplateSHA: template, Renderer: renderer, TemplateAsset: c.Asset}
	pin.CardPayload.Product = c.Product
	pin.CardPayload.TemplateFile = c.File
	return pin, nil
}
func pinFingerprint(pin mediaPin) string {
	pin.PinnedRevision = 0
	pin.PreparationOperation = ""
	pin.Manifest = nil
	raw, _ := json.Marshal(pin)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func mediaRow(ctx context.Context, tx pgx.Tx, org int64, id string) (storedScan, []byte, error) {
	row, err := scanStoredRow(tx.QueryRow(ctx, `SELECT `+rowColumns+` FROM listing_rows WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, org, id))
	if err != nil {
		return row, nil, err
	}
	var card []byte
	err = tx.QueryRow(ctx, `SELECT payload FROM listing_cards WHERE org_id=$1 AND id=$2::uuid FOR SHARE`, org, row.row.CardID).Scan(&card)
	if err == nil {
		card, err = projectSupplierCard(ctx, tx, card, time.Now().UnixMilli())
	}
	return row, card, err
}

type mediaRun struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	AggregateType  string          `json:"aggregate_type"`
	AggregateID    string          `json:"aggregate_id"`
	InputRevision  int64           `json:"input_revision"`
	State          string          `json:"state"`
	Attempt        int32           `json:"attempt"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
	UpdatedAtMs    int64           `json:"updated_at_ms"`
	fingerprint    string
	cancelled      bool
}

const mediaRunColumns = `id::text,kind,aggregate_type,aggregate_id::text,input_revision,state,attempt,idempotency_key,payload,updated_at,COALESCE(input_fingerprint,''),cancel_requested_at IS NOT NULL`

func scanMediaRun(row pgx.Row) (mediaRun, error) {
	var run mediaRun
	var updated time.Time
	err := row.Scan(&run.ID, &run.Kind, &run.AggregateType, &run.AggregateID, &run.InputRevision, &run.State, &run.Attempt, &run.IdempotencyKey, &run.Payload, &updated, &run.fingerprint, &run.cancelled)
	run.UpdatedAtMs = updated.UnixMilli()
	return run, err
}
func loadMediaRun(ctx context.Context, tx pgx.Tx, org int64, id string) (mediaRun, error) {
	return scanMediaRun(tx.QueryRow(ctx, `SELECT `+mediaRunColumns+` FROM jobs WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, org, id))
}
func checkMediaRun(run mediaRun, row storedScan, card []byte, kind string) (mediaPin, error) {
	var pin mediaPin
	if run.AggregateType != "listing_row" || run.AggregateID != row.row.ID || run.Kind != kind || run.cancelled || (run.State != "queued" && run.State != "running" && run.State != "retry_wait" && run.State != "succeeded") || json.Unmarshal(run.Payload, &pin) != nil || pin.Executor != "browser" {
		return pin, rowRefuse{409, "媒体任务已结束或与商品行不匹配", "conflict"}
	}
	current, err := mediaInput(row, card, pin.Renderer)
	if err != nil {
		return pin, err
	}
	current.ManifestDigest = pin.ManifestDigest
	if pinFingerprint(current) != run.fingerprint || pinFingerprint(pin) != run.fingerprint {
		return pin, rowRefuse{409, "原图或模板已变化，请重新准备", "conflict"}
	}
	return pin, nil
}

func (h Host) saveMediaRow(ctx context.Context, tx pgx.Tx, p access.Principal, id string, payload []byte, state string, final bool, validation, content string) (storedScan, error) {
	_, err := tx.Exec(ctx, `UPDATE listing_rows SET payload=$3::jsonb,media_state=$4,updated_by=$5,updated_at=clock_timestamp(),
 revision=revision+CASE WHEN $6 THEN 1 ELSE 0 END,validation_state=CASE WHEN $6 THEN $7 ELSE validation_state END,
 content_state=CASE WHEN $6 THEN $8 ELSE content_state END,build_state='stale',build_digest=NULL,build_card_digest=NULL
 WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id, string(payload), state, p.UserID, final, validation, content)
	if err != nil {
		return storedScan{}, err
	}
	return scanStoredRow(tx.QueryRow(ctx, `SELECT `+rowColumns+` FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id))
}
func settleMedia(ctx context.Context, tx pgx.Tx, org int64, id, state, code string) error {
	_, err := tx.Exec(ctx, `UPDATE jobs SET state=$3,last_error_code=NULLIF($4,''),lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2::uuid`, org, id, state, code)
	return err
}
