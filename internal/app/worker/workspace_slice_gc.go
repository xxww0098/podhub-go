package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/jobs/slicepurge"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func workerTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := tenantx.BeginWorker(ctx, pool.Begin)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RunWorkspaceSliceClears advances pending user requests and the daily schedule once.
func RunWorkspaceSliceClears(ctx context.Context, pool *pgxpool.Pool, key []byte) {
	var accounts []mediarepo.SliceStorage
	var requests []mediarepo.SliceClearRequest
	err := workerTx(ctx, pool, func(tx pgx.Tx) error {
		var loadErr error
		accounts, loadErr = mediarepo.ListSliceStorage(ctx, tx, key)
		if loadErr != nil {
			slog.Error("some slice credentials could not be opened")
		}
		var err error
		requests, err = mediarepo.PendingSliceClears(ctx, tx)
		return err
	})
	if err != nil {
		slog.Error("slice storage scan failed")
		return
	}
	byID := make(map[string]mediarepo.SliceStorage, len(accounts))
	valid := accounts[:0]
	for _, account := range accounts {
		a := account.Account
		cfg := media.Config{Role: media.RoleTransit, Provider: string(a.Provider), Endpoint: a.Endpoint, Region: a.Region, Bucket: a.Bucket, KeyPrefix: a.KeyPrefix, PublicBaseURL: a.PublicBaseURL, ForcePathStyle: a.ForcePathStyle, AccessKeyID: a.AccessKeyID, SecretAccessKey: a.SecretAccessKey}
		if cfg.ValidateSliceStorage() != nil {
			slog.Error("slice storage target is invalid")
			continue
		}
		byID[a.ID] = account
		valid = append(valid, account)
	}
	for _, request := range requests {
		account, ok := byID[request.StorageID]
		if !ok || account.OrgID != request.OrgID {
			continue
		}
		clearWorkspaceSlice(ctx, pool, account, &request)
	}
	for _, account := range valid {
		clearWorkspaceSlice(ctx, pool, account, nil)
	}
}

func clearWorkspaceSlice(ctx context.Context, pool *pgxpool.Pool, account mediarepo.SliceStorage, request *mediarepo.SliceClearRequest) {
	id := media.SliceClearIdentity("daily", account.Account.ID)
	var claim *slicepurge.PG
	var err error
	if request == nil {
		claim, err = slicepurge.TryClaimScheduled(ctx, pool, id, account.OrgID, account.Account.ID)
	} else {
		id = media.SliceClearIdentity("manual", request.ID)
		claim, err = slicepurge.TryClaimManual(ctx, pool, id)
	}
	if err != nil {
		slog.Error("slice clear claim failed")
		if request != nil {
			_ = workerTx(ctx, pool, func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `UPDATE public.workspace_slice_clear_requests SET error_code='slice_claim_failed' WHERE id=$1::uuid AND finished_at IS NULL`, request.ID)
				return err
			})
		}
		return
	}
	if claim == nil {
		if request != nil {
			_ = workerTx(ctx, pool, func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `UPDATE public.workspace_slice_clear_requests SET finished_at=clock_timestamp(),error_code=NULL
					WHERE id=$1::uuid AND finished_at IS NULL AND EXISTS (SELECT 1 FROM public.transit_clear_runs WHERE bucket_identity=$2 AND status='completed')`, request.ID, id)
				return err
			})
		}
		return
	}
	boundary := claim.Boundary()
	if request != nil {
		boundary = request.RequestedAt
	}
	var observed time.Time
	err = workerTx(ctx, pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&observed); err != nil {
			return err
		}
		if request == nil {
			return nil
		}
		_, err := tx.Exec(ctx, `UPDATE public.media_object_leases SET retired_at=clock_timestamp(),updated_at=clock_timestamp()
			WHERE media_account_id=$1 AND retired_at IS NULL AND
			CASE WHEN batch_id ~ '^[0-9]{13,18}-' THEN split_part(batch_id,'-',1)::numeric < extract(epoch FROM $2::timestamptz)*1000
			ELSE first_seen_at<=$2 END`, account.Account.ID, boundary)
		return err
	})
	if err != nil {
		_, _ = claim.RetryLater(ctx, "slice_retire_failed")
		if request != nil {
			_ = workerTx(ctx, pool, func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `UPDATE public.workspace_slice_clear_requests SET error_code='slice_retire_failed' WHERE id=$1::uuid AND finished_at IS NULL`, request.ID)
				return err
			})
		}
		return
	}
	var settlesAfter time.Time
	if remaining := boundary.Add(16 * time.Minute).Sub(observed); request != nil && remaining > 0 {
		settlesAfter = time.Now().Add(remaining)
	}
	origin := slicepurge.AccountOrigin{Account: account.Account, Before: boundary, SettlesAfter: settlesAfter}
	if request == nil {
		origin.SelectKeys = func(ctx context.Context, keys []string) ([]string, error) {
			var retired []string
			err := workerTx(ctx, pool, func(tx pgx.Tx) error {
				if err := mediarepo.RetireFetchedSlices(ctx, tx, account.OrgID, account.Account.ID, boundary, keys); err != nil {
					return err
				}
				var err error
				retired, err = mediarepo.RetiredSliceKeys(ctx, tx, account.OrgID, account.Account.ID, keys)
				return err
			})
			return retired, err
		}
	}
	report := slicepurge.Run(ctx, claim, origin, nil)
	if request != nil {
		_ = workerTx(ctx, pool, func(tx pgx.Tx) error {
			if report.Completed && report.StateRecorded {
				_, err := tx.Exec(ctx, `UPDATE public.workspace_slice_clear_requests SET finished_at=clock_timestamp(),error_code=NULL WHERE id=$1::uuid AND finished_at IS NULL`, request.ID)
				return err
			}
			if report.StopCode == "slice_wait_uploads" {
				_, err := tx.Exec(ctx, `UPDATE public.workspace_slice_clear_requests SET error_code=NULL WHERE id=$1::uuid AND finished_at IS NULL`, request.ID)
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE public.workspace_slice_clear_requests SET error_code=$2 WHERE id=$1::uuid AND finished_at IS NULL`, request.ID, report.StopCode)
			return err
		})
	}
	if !report.Completed && report.StopCode != "slice_wait_uploads" {
		slog.Error("slice clear incomplete", "code", report.StopCode)
	}
}
