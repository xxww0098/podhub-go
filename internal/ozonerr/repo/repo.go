package ozonerrrepo

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Repo writes observations under the tenant GUC and the global catalog as
// podhub_ozon_catalog. Lock order is sighting, then observation, then catalog.
type Repo struct {
	pool *pgxpool.Pool
}

// New binds a pool. A nil pool fails the next call.
func New(pool *pgxpool.Pool) *Repo {
	return &Repo{pool: pool}
}

// Insert adds each new sighting once, then increments the org row and the
// global row. A conflict on the sighting key increments nothing.
func (r *Repo) Insert(ctx context.Context, orgID int64, rows []domain.Row) (int, error) {
	if r == nil || r.pool == nil || orgID <= 0 {
		return 0, errors.New("ozon catalog pool")
	}
	tx, err := tenant.BeginApp(ctx, r.pool.Begin, orgID)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	n, err := writeTx(ctx, tx, orgID, rows)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// InsertRequest reads the intent's offer id and records one request-layer
// error. Without a shared task id the idempotency key is the intent id and
// the offer stored on the intent, not a client-supplied offer. With a shared
// task id the key matches a proxied 4xx: the decimal task id and an empty
// offer. The request body is not stored.
func (r *Repo) InsertRequest(ctx context.Context, orgID int64, intentID, code, sample, taskKey string) error {
	if r == nil || r.pool == nil || orgID <= 0 || code == "" {
		return errors.New("ozon catalog pool")
	}
	if _, err := uuid.Parse(intentID); err != nil {
		return nil
	}
	tx, err := tenant.BeginApp(ctx, r.pool.Begin, orgID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var offer string
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(offer_id, '')
		  FROM public.submission_intents
		 WHERE org_id = $1 AND id = $2::uuid`, orgID, intentID).Scan(&offer)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	key := "intent:" + intentID
	offerKey := offer
	if shared := domain.SharedTaskKey(taskKey); shared != "" {
		key = shared
		offerKey = ""
	}
	_, err = writeTx(ctx, tx, orgID, []domain.Row{{
		Source:   domain.SourceRequest,
		Code:     code,
		Sample:   sample,
		TaskKey:  key,
		OfferKey: offerKey,
	}})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func writeTx(ctx context.Context, tx pgx.Tx, orgID int64, rows []domain.Row) (int, error) {
	sorted := append([]domain.Row(nil), rows...)
	sort.Slice(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		if a.AttributeID != b.AttributeID {
			return a.AttributeID < b.AttributeID
		}
		if a.DescriptionCategoryID != b.DescriptionCategoryID {
			return a.DescriptionCategoryID < b.DescriptionCategoryID
		}
		if a.TypeID != b.TypeID {
			return a.TypeID < b.TypeID
		}
		if a.OfferKey != b.OfferKey {
			return a.OfferKey < b.OfferKey
		}
		if a.TaskKey != b.TaskKey {
			return a.TaskKey < b.TaskKey
		}
		return a.Source < b.Source
	})
	var fresh []domain.Row
	for _, row := range sorted {
		tag, err := tx.Exec(ctx, `
			INSERT INTO public.ozon_error_sighting (
				org_id, task_key, offer_key, source, code, attribute_id, description_category_id, type_id
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT DO NOTHING`,
			orgID, row.TaskKey, row.OfferKey, row.Source, row.Code, row.AttributeID, row.DescriptionCategoryID, row.TypeID)
		if err != nil {
			return 0, err
		}
		if tag.RowsAffected() == 1 {
			fresh = append(fresh, row)
		}
	}
	for _, row := range fresh {
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.ozon_error_observation (
				org_id, source, code, attribute_id, description_category_id, type_id,
				level, state, field, attribute_name, sample_description, occurrences
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
			ON CONFLICT (org_id, source, code, attribute_id, description_category_id, type_id)
			DO UPDATE SET
				occurrences = public.ozon_error_observation.occurrences + 1,
				last_seen_at = clock_timestamp()`,
			orgID, row.Source, row.Code, row.AttributeID, row.DescriptionCategoryID, row.TypeID,
			row.Level, row.State, row.Field, row.AttributeName, row.Sample); err != nil {
			return 0, err
		}
	}
	if len(fresh) == 0 {
		return 0, nil
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_ozon_catalog', true)`); err != nil {
		return 0, err
	}
	for _, row := range fresh {
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.ozon_error_catalog (
				source, code, attribute_id, description_category_id, type_id,
				level, state, field, attribute_name, sample_description, occurrences
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
			ON CONFLICT (source, code, attribute_id, description_category_id, type_id)
			DO UPDATE SET
				occurrences = public.ozon_error_catalog.occurrences + 1,
				last_seen_at = clock_timestamp()
			WHERE public.ozon_error_catalog.source <> 'docs_seed'`,
			row.Source, row.Code, row.AttributeID, row.DescriptionCategoryID, row.TypeID,
			row.Level, row.State, row.Field, row.AttributeName, row.Sample); err != nil {
			return 0, err
		}
	}
	return len(fresh), nil
}

// ListGlobal reads the global catalog as a super-admin observer.
func (r *Repo) ListGlobal(ctx context.Context, userID int64, q domain.Query) ([]domain.Entry, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("ozon catalog pool")
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		SELECT set_config('role', 'podhub_app', true), set_config('app.platform_observer_id', $1, true)`,
		strconv.FormatInt(userID, 10)); err != nil {
		return nil, err
	}
	return queryPage(ctx, tx, "public.ozon_error_catalog", q)
}

// ListOrg reads one organization's observations under the tenant GUC.
func (r *Repo) ListOrg(ctx context.Context, orgID int64, q domain.Query) ([]domain.Entry, error) {
	if r == nil || r.pool == nil || orgID <= 0 {
		return nil, errors.New("ozon catalog pool")
	}
	tx, err := tenant.BeginApp(ctx, r.pool.Begin, orgID)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return queryPage(ctx, tx, "public.ozon_error_observation", q)
}

func queryPage(ctx context.Context, tx pgx.Tx, table string, q domain.Query) ([]domain.Entry, error) {
	if table != "public.ozon_error_catalog" && table != "public.ozon_error_observation" {
		return nil, errors.New("ozon catalog table")
	}
	var cat, typ any
	if q.Category != nil {
		cat = *q.Category
	}
	if q.TypeID != nil {
		typ = *q.TypeID
	}
	limit := q.Limit
	if limit < 1 || limit > 100 {
		limit = 50
	}
	sql := `
		SELECT source, code, attribute_id, description_category_id, type_id,
		       level, state, field, attribute_name, sample_description,
		       occurrences, first_seen_at, last_seen_at
		  FROM ` + table + `
		 WHERE ($1 = '' OR code = $1)
		   AND ($2::bigint IS NULL OR description_category_id = $2)
		   AND ($3::bigint IS NULL OR type_id = $3)`
	args := []any{q.Code, cat, typ}
	if q.Sort == "last_seen" {
		var seen any
		if q.HasCursor {
			seen = time.UnixMicro(q.Cursor.LastSeenUnix).UTC()
		}
		sql += `
		   AND (
		        $4::timestamptz IS NULL
		        OR last_seen_at < $4
		        OR (last_seen_at = $4 AND (source, code, attribute_id, description_category_id, type_id) > ($5, $6, $7, $8, $9))
		   )
		 ORDER BY last_seen_at DESC, source, code, attribute_id, description_category_id, type_id
		 LIMIT $10`
		args = append(args, seen, q.Cursor.Source, q.Cursor.Code, q.Cursor.AttributeID, q.Cursor.Category, q.Cursor.TypeID, limit+1)
	} else {
		var occ any
		if q.HasCursor {
			occ = q.Cursor.Occurrences
		}
		sql += `
		   AND (
		        $4::bigint IS NULL
		        OR occurrences < $4
		        OR (occurrences = $4 AND (source, code, attribute_id, description_category_id, type_id) > ($5, $6, $7, $8, $9))
		   )
		 ORDER BY occurrences DESC, source, code, attribute_id, description_category_id, type_id
		 LIMIT $10`
		args = append(args, occ, q.Cursor.Source, q.Cursor.Code, q.Cursor.AttributeID, q.Cursor.Category, q.Cursor.TypeID, limit+1)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Entry
	for rows.Next() {
		var row domain.Entry
		var first, last time.Time
		if err := rows.Scan(
			&row.Source, &row.Code, &row.AttributeID, &row.DescriptionCategoryID, &row.TypeID,
			&row.Level, &row.State, &row.Field, &row.AttributeName, &row.Sample,
			&row.Occurrences, &first, &last,
		); err != nil {
			return nil, err
		}
		row.FirstSeen = first.UTC().Format(time.RFC3339Nano)
		row.LastSeen = last.UTC().Format(time.RFC3339Nano)
		row.LastSeenUnix = last.UTC().UnixMicro()
		out = append(out, row)
	}
	return out, rows.Err()
}
