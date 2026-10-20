package submit

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

// OrgSubmitBatchLimit is how many listing.submit.batch jobs of one
// organization may send at once. Rust 0.0.112 has no cap; the number is a
// Go decision and the regression test raises it so the lease lock is visible.
var OrgSubmitBatchLimit = 2

const leaseLockTries = 3

// commitTaskIDs stores one import's task id on every intent in its own
// transaction, before any media_object_leases write. State is unchanged.
// One statement covers the chunk; a per-intent UPDATE would leave the same
// external_task_id and the same state.
func commitTaskIDs(ctx context.Context, pool *pgxpool.Pool, orgID int64, ids []string, task int64) error {
	if task <= 0 || len(ids) == 0 {
		return nil
	}
	text := strconv.FormatInt(task, 10)
	var last error
	for try := 0; try < leaseLockTries; try++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := commitTaskOnce(ctx, pool, orgID, ids, text)
		if err == nil {
			return nil
		}
		last = err
		if err := wait(ctx, 20*time.Millisecond); err != nil {
			return err
		}
	}
	return last
}

func commitTaskOnce(ctx context.Context, pool *pgxpool.Pool, orgID int64, ids []string, task string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.submission_intents
		   SET external_task_id = $3,
		       updated_at = clock_timestamp()
		 WHERE org_id = $1
		   AND id = ANY($2::uuid[])
		   AND (external_task_id IS NULL OR external_task_id = $3)`,
		orgID, ids, task); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// touchLeases updates media_object_leases rows named by the import's image
// URLs. Rows another transaction holds are skipped. A short retry then
// returns ErrLockBusy without touching the receipt.
func touchLeases(ctx context.Context, pool *pgxpool.Pool, orgID int64, bodies ...[]byte) error {
	hashes := imageDigests(bodies...)
	if len(hashes) == 0 {
		return nil
	}
	workspace, err := orgWorkspace(ctx, pool, orgID)
	if err != nil {
		return err
	}
	var last error
	for try := 0; try < leaseLockTries; try++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		busy, err := touchOnce(ctx, pool, workspace, hashes)
		if err != nil {
			return err
		}
		if !busy {
			return nil
		}
		last = queue.ErrLockBusy
		if err := wait(ctx, 20*time.Millisecond); err != nil {
			return err
		}
	}
	if last == nil {
		return queue.ErrLockBusy
	}
	return last
}

func touchOnce(ctx context.Context, pool *pgxpool.Pool, workspace string, hashes []string) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return false, err
	}
	var existing int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM public.media_object_leases
		 WHERE workspace_uuid = $1::uuid
		   AND content_hash = ANY($2::text[])
		   AND deleted_at IS NULL
		   AND retired_at IS NULL`, workspace, hashes).Scan(&existing); err != nil {
		return false, err
	}
	if existing == 0 {
		return false, tx.Commit(ctx)
	}
	rows, err := tx.Query(ctx, `
		SELECT batch_id, content_hash
		  FROM public.media_object_leases
		 WHERE workspace_uuid = $1::uuid
		   AND content_hash = ANY($2::text[])
		   AND deleted_at IS NULL
		   AND retired_at IS NULL
		   FOR UPDATE SKIP LOCKED`, workspace, hashes)
	if err != nil {
		return false, err
	}
	type key struct{ batch, hash string }
	var locked []key
	for rows.Next() {
		var item key
		if err := rows.Scan(&item.batch, &item.hash); err != nil {
			rows.Close()
			return false, err
		}
		locked = append(locked, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	for _, item := range locked {
		if _, err := tx.Exec(ctx, `
			UPDATE public.media_object_leases
			   SET updated_at = clock_timestamp()
			 WHERE workspace_uuid = $1::uuid AND batch_id = $2 AND content_hash = $3`,
			workspace, item.batch, item.hash); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return len(locked) < existing, nil
}

func orgWorkspace(ctx context.Context, pool *pgxpool.Pool, orgID int64) (string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return "", err
	}
	var id string
	if err := tx.QueryRow(ctx, `SELECT uuid::text FROM public.organizations WHERE id = $1`, orgID).Scan(&id); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// orgBatchBusy reports that other running batch jobs already fill the cap.
// The job calling this is running too, so it is excluded.
func orgBatchBusy(ctx context.Context, pool *pgxpool.Pool, orgID int64, jobID string) (bool, error) {
	limit := OrgSubmitBatchLimit
	if limit < 1 {
		limit = 1
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return false, err
	}
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM public.jobs
		 WHERE org_id = $1 AND kind = 'listing.submit.batch' AND state = 'running'
		   AND id <> $2::uuid`, orgID, jobID).Scan(&n); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return n >= limit, nil
}

type intentFact struct {
	state string
	task  string
}

func intentFacts(ctx context.Context, pool *pgxpool.Pool, orgID int64, ids []string) (map[string]intentFact, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, state, external_task_id
		  FROM public.submission_intents
		 WHERE org_id = $1 AND id = ANY($2::uuid[])`, orgID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]intentFact{}
	for rows.Next() {
		var id string
		var fact intentFact
		var task *string
		if err := rows.Scan(&id, &fact.state, &task); err != nil {
			return nil, err
		}
		if task != nil {
			fact.task = *task
		}
		out[id] = fact
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func imageDigests(bodies ...[]byte) []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(url string) {
		key, ok := ParseUploadKey(url)
		if !ok || key.Digest == "" {
			return
		}
		if _, dup := seen[key.Digest]; dup {
			return
		}
		seen[key.Digest] = struct{}{}
		out = append(out, key.Digest)
	}
	for _, body := range bodies {
		var doc struct {
			Items []struct {
				Images  []string `json:"images"`
				Primary string   `json:"primary_image"`
			} `json:"items"`
		}
		if json.Unmarshal(body, &doc) != nil {
			continue
		}
		for _, item := range doc.Items {
			for _, url := range item.Images {
				add(url)
			}
			add(item.Primary)
		}
	}
	return out
}

func receiptBody(task string) string {
	return `{"result":{"task_id":` + task + `}}`
}

func wait(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
