package telemetryrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

const digestInsert = `
INSERT INTO public.error_digest (
    org_id, fingerprint, route_template, status_code, event_count,
    first_at, last_at, summary, window_start
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (org_id, fingerprint, route_template, status_code, window_start)
DO UPDATE SET
    event_count = EXCLUDED.event_count,
    first_at = EXCLUDED.first_at,
    last_at = EXCLUDED.last_at,
    summary = EXCLUDED.summary`

// ErrorWindow reads error-class inbox rows in [start, end). Payload stays in
// the returned value only so the caller can project it. This method does not
// write the payload.
func (r *Repo) ErrorWindow(ctx context.Context, start, end time.Time) ([]domain.Observation, error) {
	if r == nil || r.pool == nil {
		return nil, domain.Unavailable()
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, domain.Unavailable()
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT org_id, kind, payload_json, received_at
		  FROM public.event_inbox_events
		 WHERE received_at >= $1
		   AND received_at < $2
		   AND kind = ANY($3::text[])`, start, end, domain.ErrorClassKinds)
	if err != nil {
		return nil, domain.Unavailable()
	}
	defer rows.Close()
	var out []domain.Observation
	for rows.Next() {
		var item domain.Observation
		if err := rows.Scan(&item.OrgID, &item.Kind, &item.Payload, &item.At); err != nil {
			return nil, domain.Unavailable()
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, domain.Unavailable()
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, domain.Unavailable()
	}
	return out, nil
}

// SaveDigest writes tenant rows under each org GUC and platform rows as
// podhub_digest_platform. It does not update jobs, billing, or the inbox.
func (r *Repo) SaveDigest(ctx context.Context, rows []domain.DigestRow) error {
	if r == nil || r.pool == nil {
		return domain.Unavailable()
	}
	byOrg := map[int64][]domain.DigestRow{}
	var platform []domain.DigestRow
	for _, row := range rows {
		if row.Platform {
			platform = append(platform, row)
			continue
		}
		if row.OrgID <= 0 {
			return domain.Unavailable()
		}
		byOrg[row.OrgID] = append(byOrg[row.OrgID], row)
	}
	for orgID, batch := range byOrg {
		if err := r.saveTenant(ctx, orgID, batch); err != nil {
			return err
		}
	}
	if len(platform) == 0 {
		return nil
	}
	return r.savePlatform(ctx, platform)
}

func (r *Repo) saveTenant(ctx context.Context, orgID int64, batch []domain.DigestRow) error {
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		for _, row := range batch {
			if row.Platform || row.OrgID != orgID {
				return domain.Unavailable()
			}
			if _, err := tx.Exec(ctx, digestInsert,
				row.OrgID, row.Fingerprint, row.RouteTemplate, row.StatusCode, row.Count,
				row.FirstAt, row.LastAt, row.Summary, row.WindowStart); err != nil {
				return domain.Unavailable()
			}
		}
		return nil
	})
	if err != nil {
		return domain.Unavailable()
	}
	return nil
}

func (r *Repo) savePlatform(ctx context.Context, batch []domain.DigestRow) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.Unavailable()
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_digest_platform', true)`); err != nil {
		return domain.Unavailable()
	}
	for _, row := range batch {
		if !row.Platform || row.OrgID != 0 {
			return domain.Unavailable()
		}
		if _, err := tx.Exec(ctx, digestInsert,
			nil, row.Fingerprint, row.RouteTemplate, row.StatusCode, row.Count,
			row.FirstAt, row.LastAt, row.Summary, row.WindowStart); err != nil {
			return domain.Unavailable()
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Unavailable()
	}
	return nil
}
