package ozonerrrepo

import (
	"context"
	"errors"
	"time"

	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
)

// samplePruneRole may blank sample_description and nothing else.
// It is NOLOGIN, not superuser, and not BYPASSRLS.
const samplePruneRole = "podhub_ozon_sample_prune"

// ClearExpiredSamples blanks live samples whose last_seen_at is strictly
// before the 180-day cutoff. occurrences, first_seen_at, and last_seen_at
// stay. docs_seed is not updated. A zero now uses the current UTC time so
// an unset clock cannot treat every row as expired.
func (r *Repo) ClearExpiredSamples(ctx context.Context, now time.Time) (int64, error) {
	if r == nil || r.pool == nil {
		return 0, errors.New("ozon catalog pool")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cutoff := domain.SampleCutoff(now)
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, samplePruneRole); err != nil {
		return 0, err
	}
	catalog, err := tx.Exec(ctx, `
		UPDATE public.ozon_error_catalog
		   SET sample_description = ''
		 WHERE sample_description <> ''
		   AND source <> 'docs_seed'
		   AND last_seen_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	observation, err := tx.Exec(ctx, `
		UPDATE public.ozon_error_observation
		   SET sample_description = ''
		 WHERE sample_description <> ''
		   AND last_seen_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return catalog.RowsAffected() + observation.RowsAffected(), nil
}
