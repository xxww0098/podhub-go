package readhttp

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// AuthorizeOCR locks the live row and task in the purchase transaction. A paid
// result can be applied after cancellation, but cancellation forbids a new call.
func (h Host) AuthorizeOCR(ctx context.Context, tx pgx.Tx, p access.Principal, claim ai.Claim, key string, purchase bool) (ai.Binding, error) {
	var out ai.Binding
	if _, ok := CanonicalUUID(claim.JobID); !ok || claim.Lease.Owner == "" || claim.Lease.Epoch < 1 || p.TokenHash == "" {
		return out, rowRefuse{409, "识别任务租约无效", "conflict"}
	}
	if err := lockPreparationPrincipal(ctx, tx, p); err != nil {
		return out, err
	}
	var valid bool
	var rowID string
	if err := tx.QueryRow(ctx, `SELECT aggregate_id::text FROM jobs WHERE org_id=$1 AND id=$2::uuid AND aggregate_type='listing_row' AND kind='ai.recognize'`, p.OrgID, claim.JobID).Scan(&rowID); err != nil {
		return out, err
	}
	row, card, err := mediaRow(ctx, tx, p.OrgID, p.UserID, rowID)
	if err != nil {
		return out, err
	}
	var raw []byte
	var state string
	var owner *string
	var epoch, user int64
	var live, cancelled bool
	err = tx.QueryRow(ctx, `SELECT payload,state,lease_owner,lease_epoch,COALESCE(submitter_user_id,0),COALESCE(lease_until>clock_timestamp(),false),cancel_requested_at IS NOT NULL,COALESCE(input_fingerprint,''),idempotency_key FROM jobs WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, p.OrgID, claim.JobID).Scan(&raw, &state, &owner, &epoch, &user, &live, &cancelled, &out.Fingerprint, &out.Key)
	if err != nil {
		return out, err
	}
	if json.Unmarshal(raw, &out.Pin) != nil || out.Pin.Contract != recognitionContract {
		return out, rowRefuse{409, "识别任务契约不匹配", "conflict"}
	}
	if user != p.UserID || epoch != claim.Lease.Epoch || (owner != nil && *owner != claim.Lease.Owner) || (purchase && (owner == nil || !live || cancelled || state != "running")) || (!purchase && state != "running" && state != "uncertain" && state != "cancelled" && state != "succeeded") {
		return out, rowRefuse{409, "识别任务已结束或租约已变化", "conflict"}
	}
	if key != "" && key != out.Key {
		return out, rowRefuse{409, "识别付款编号不属于当前任务", "conflict"}
	}
	current, err := recognitionInput(ctx, tx, row, card, out.Pin.Routing)
	if err != nil {
		return out, err
	}
	if recognitionFingerprint(current) != out.Fingerprint || recognitionFingerprint(out.Pin) != out.Fingerprint {
		return out, rowRefuse{409, "原图或识别配置已变化", "conflict"}
	}
	if purchase {
		if _, err = writer.Assert(ctx, tx, "recipe", writer.ProcessIdentity(), h.clock().UnixMilli(), "识别写入未启用"); err != nil {
			return out, err
		}
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM execution_permits WHERE org_id=$1 AND holder_kind='job' AND holder_id=$2 AND lease_epoch=$3 AND class='ai_ocr' AND released_at IS NULL AND expires_at>clock_timestamp())`, p.OrgID, claim.JobID, claim.Lease.Epoch).Scan(&valid); err != nil {
			return out, err
		}
		if !valid {
			return out, rowRefuse{409, "识别执行额度已过期，请重新领取任务", "conflict"}
		}
	}
	out.RowID = rowID
	out.Lease = claim.Lease
	return out, nil
}
