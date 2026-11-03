package readhttp

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

type storePolicy struct {
	StoreID          string     `json:"store_id"`
	DailyCap         *int       `json:"daily_cap"`
	MinGapSeconds    int        `json:"min_gap_seconds"`
	Timezone         string     `json:"timezone"`
	SubmittedToday   int        `json:"submitted_today"`
	LastDispatchedAt *time.Time `json:"last_dispatched_at"`
	NextAllowedAt    *time.Time `json:"next_allowed_at"`
	WaitReason       *string    `json:"wait_reason"`
	CanManage        bool       `json:"can_manage"`
}

func (h Host) getStorePolicy(w http.ResponseWriter, r *http.Request) {
	h.storePolicy(w, r, false)
}

func (h Host) putStorePolicy(w http.ResponseWriter, r *http.Request) {
	h.storePolicy(w, r, true)
}

func (h Host) storePolicy(w http.ResponseWriter, r *http.Request, update bool) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	if update && crossOriginWrite(r) {
		writeCSRF(w)
		return
	}
	storeID, valid := CanonicalUUID(chi.URLParam(r, "store_id"))
	if !valid {
		writeErr(w, http.StatusBadRequest, "店铺标识无效", "validation")
		return
	}
	var input struct {
		DailyCap      *int `json:"daily_cap"`
		MinGapSeconds int  `json:"min_gap_seconds"`
	}
	if update {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		if err != nil || !jsonObject(raw) || decode(raw, &input) != nil || input.DailyCap != nil && (*input.DailyCap < 1 || *input.DailyCap > 1000000) || input.MinGapSeconds < 0 || input.MinGapSeconds > 86400 {
			writeErr(w, http.StatusBadRequest, "每日上限须为 1–1000000 或不限制，发送间隔须为 0–86400 秒", "validation")
			return
		}
	}
	result := storePolicy{StoreID: storeID, Timezone: "Asia/Shanghai"}
	err := db.InTx(r.Context(), h.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		if err := lockLiveOrg(r.Context(), tx, p.OrgID, "工作空间不存在"); err != nil {
			return err
		}
		seat, found, err := loadSeat(r.Context(), tx, p.OrgID, p.UserID)
		if err != nil {
			return err
		}
		if !found {
			return halt{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
		}
		result.CanManage = seat.manageAll
		if err := requireIntentStore(r.Context(), tx, p.OrgID, p.UserID, storeID); err != nil {
			return err
		}
		if update && !seat.manageAll {
			return halt{http.StatusForbidden, "需要工作空间管理员权限", "forbidden"}
		}
		var storePK int64
		if err := tx.QueryRow(r.Context(), `SELECT id FROM public.organization_stores WHERE org_id=$1 AND uuid=$2::uuid AND deleted_at_ms IS NULL FOR NO KEY UPDATE`, p.OrgID, storeID).Scan(&storePK); err != nil {
			return err
		}
		if update {
			if _, err := tx.Exec(r.Context(), `INSERT INTO public.store_listing_policies(org_id,store_id,daily_cap,min_gap_seconds)
				VALUES($1,$2,$3,$4) ON CONFLICT(store_id) DO UPDATE SET daily_cap=EXCLUDED.daily_cap,min_gap_seconds=EXCLUDED.min_gap_seconds,updated_at=clock_timestamp()`, p.OrgID, storePK, input.DailyCap, input.MinGapSeconds); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `WITH waiting AS (
				SELECT id FROM public.jobs WHERE org_id=$1 AND state='retry_wait'
				AND kind IN ('listing.submit','listing.submit.batch')
				AND last_error_code IN ('STORE_DAILY_CAP_REACHED','STORE_MIN_SEND_GAP')
				AND (payload->>'storeId'=$2 OR payload->>'storePk'=$3) FOR UPDATE SKIP LOCKED
			) UPDATE public.jobs SET run_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id IN (SELECT id FROM waiting)`, p.OrgID, storeID, strconv.FormatInt(storePK, 10)); err != nil {
				return err
			}
		}
		return readStorePolicy(r.Context(), tx, p.OrgID, storePK, &result)
	})
	if !h.writeTx(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, result)
}

func readStorePolicy(ctx context.Context, tx pgx.Tx, orgID, storePK int64, result *storePolicy) error {
	err := tx.QueryRow(ctx, `SELECT daily_cap,min_gap_seconds FROM public.store_listing_policies WHERE org_id=$1 AND store_id=$2`, orgID, storePK).Scan(&result.DailyCap, &result.MinGapSeconds)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return err
	}
	local := now.In(time.FixedZone("Asia/Shanghai", 8*60*60))
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE created_at >= $3),max(created_at)
		FROM public.seller_upstream_writes WHERE org_id=$1 AND store_id=$2 AND kind='import' AND error_code IS DISTINCT FROM 'not_dispatched'`, orgID, storePK, day).Scan(&result.SubmittedToday, &result.LastDispatchedAt); err != nil {
		return err
	}
	if result.DailyCap != nil && result.SubmittedToday >= *result.DailyCap {
		next, reason := day.Add(24*time.Hour), "STORE_DAILY_CAP_REACHED"
		result.NextAllowedAt, result.WaitReason = &next, &reason
	}
	if result.MinGapSeconds > 0 && result.LastDispatchedAt != nil {
		next := result.LastDispatchedAt.Add(time.Duration(result.MinGapSeconds) * time.Second)
		if next.After(now) && (result.NextAllowedAt == nil || next.After(*result.NextAllowedAt)) {
			reason := "STORE_MIN_SEND_GAP"
			result.NextAllowedAt, result.WaitReason = &next, &reason
		}
	}
	return nil
}
