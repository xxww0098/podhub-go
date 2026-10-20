package submit

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// ProbeDue is reconcile_due_unknown_imports. The claim SQL is claim_due in
// src/listing/kernel/submission/import_reconcile.rs at a03d735. The claim
// commits before the read. A missing credential row is unreadable, so an
// absence streak does not advance. Nothing here calls /v3/product/import.
func ProbeDue(ctx context.Context, pool *pgxpool.Pool, tr Transport, limit int) (int, error) {
	if limit <= 0 {
		limit = 16
	}
	if limit > 64 {
		limit = 64
	}
	if _, err := recoverStuckSubmitting(ctx, pool, limit); err != nil {
		return 0, err
	}
	claimed, err := claimDue(ctx, pool, limit)
	if err != nil || len(claimed) == 0 {
		return len(claimed), err
	}
	groups := map[probeKey][]claimedIntent{}
	for _, row := range claimed {
		key := probeKey{org: row.OrgID, store: row.StoreID}
		groups[key] = append(groups[key], row)
	}
	for key, rows := range groups {
		sights := readStore(ctx, pool, tr, key, rows)
		if err := applyGroup(ctx, pool, key.org, rows, sights); err != nil {
			return len(claimed), err
		}
	}
	return len(claimed), nil
}

type probeKey struct {
	org   int64
	store string
}

type claimedIntent struct {
	ID          string
	OrgID       int64
	StoreID     string
	OfferID     string
	RowID       string
	Revision    int64
	Passes      int32
	Observation string
}

func claimDue(ctx context.Context, pool *pgxpool.Pool, limit int) ([]claimedIntent, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, claimDueSQL, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var claimed []claimedIntent
	for rows.Next() {
		var row claimedIntent
		var observation *string
		if err := rows.Scan(&row.ID, &row.OrgID, &row.StoreID, &row.OfferID, &row.RowID, &row.Revision, &row.Passes, &observation); err != nil {
			return nil, err
		}
		if observation != nil {
			row.Observation = *observation
		}
		claimed = append(claimed, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claimed, nil
}

const claimDueSQL = `
WITH due AS (
    SELECT id FROM submission_intents
    WHERE state = 'unknown'
      AND offer_id IS NOT NULL AND btrim(offer_id) <> ''
      AND (
        reconcile_after <= clock_timestamp()
        OR (reconcile_after IS NULL
            AND last_error_code IS DISTINCT FROM 'OZON_RECONCILE_STILL_UNKNOWN')
      )
      AND (reconcile_claim_until IS NULL OR reconcile_claim_until <= clock_timestamp())
    ORDER BY reconcile_after NULLS FIRST, updated_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE submission_intents AS current
SET reconcile_claim_until = clock_timestamp() + interval '2 minutes',
    updated_at = clock_timestamp()
FROM due WHERE current.id = due.id
RETURNING current.id::text, current.org_id, current.store_id::text,
    current.offer_id, current.listing_row_id::text, current.row_revision,
    COALESCE((current.reconciliation_outcome->'probe'->>'passes')::int, 0),
    current.reconciliation_outcome->'probe'->>'observation'`

func readStore(ctx context.Context, pool *pgxpool.Pool, tr Transport, key probeKey, rows []claimedIntent) map[string]sightHit {
	out := map[string]sightHit{}
	mark := func(sight Sight) {
		for _, row := range rows {
			out[row.ID] = sightHit{Sight: sight}
		}
	}
	if tr == nil || !credentialPresent(ctx, pool, key) {
		mark(SightUnreadable)
		return out
	}
	found := map[string]Found{}
	offers := make([]string, 0, len(rows))
	for _, row := range rows {
		offers = append(offers, row.OfferID)
	}
	for start := 0; start < len(offers); start += 50 {
		end := start + 50
		if end > len(offers) {
			end = len(offers)
		}
		body, err := json.Marshal(map[string]any{"offer_id": offers[start:end]})
		if err != nil {
			mark(SightUnreadable)
			return out
		}
		status, resp, err := tr.Read(ctx, "/v3/product/info/list", body)
		items, ok := parseInfoList(status, resp, err)
		if !ok {
			mark(SightUnreadable)
			return out
		}
		for _, item := range items {
			if item.ProductID > 0 && item.OfferID != "" {
				found[item.OfferID] = Found{ProductID: item.ProductID, SKU: item.SKU}
			}
		}
	}
	for _, row := range rows {
		if product, ok := found[row.OfferID]; ok {
			out[row.ID] = sightHit{Sight: SightFound, Found: product}
			continue
		}
		out[row.ID] = sightHit{Sight: SightAbsent}
	}
	return out
}

func credentialPresent(ctx context.Context, pool *pgxpool.Pool, key probeKey) bool {
	var n int
	err := pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM public.store_seller_credentials c
		  JOIN public.organization_stores s ON s.id = c.store_id
		 WHERE c.org_id = $1 AND s.uuid = $2::uuid`, key.org, key.store).Scan(&n)
	return err == nil && n > 0
}

type sightHit struct {
	Sight Sight
	Found Found
}

type infoItem struct {
	ProductID int64
	OfferID   string
	SKU       int64
}

func parseInfoList(status int, body string, err error) ([]infoItem, bool) {
	if err != nil || status < 200 || status >= 300 {
		return nil, false
	}
	var parsed struct {
		Items []rawProduct `json:"items"`
	}
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return nil, false
	}
	out := make([]infoItem, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		sku := int64(0)
		for _, source := range item.Sources {
			if source.SKU > 0 {
				sku = source.SKU
				break
			}
		}
		out = append(out, infoItem{ProductID: item.ID, OfferID: item.OfferID, SKU: sku})
	}
	return out, true
}

type rawProduct struct {
	ID      int64  `json:"id"`
	OfferID string `json:"offer_id"`
	Sources []struct {
		SKU int64 `json:"sku"`
	} `json:"sources"`
}

func applyGroup(ctx context.Context, pool *pgxpool.Pool, orgID int64, rows []claimedIntent, sights map[string]sightHit) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	for _, row := range rows {
		hit, ok := sights[row.ID]
		if !ok {
			hit.Sight = SightUnreadable
		}
		action := DecideProbe(ProbeMemory{Passes: row.Passes, Observation: row.Observation}, hit.Sight, hit.Found)
		switch action.Kind {
		case "accept":
			tag, err := tx.Exec(ctx, stampAcceptSQL, orgID, row.ID, action.ProductID, action.SKU)
			if err != nil {
				return err
			}
			if tag.RowsAffected() > 0 {
				if _, err := tx.Exec(ctx, setRowStateSQL, orgID, row.RowID, row.Revision, Accepted); err != nil {
					return err
				}
			}
		case "release":
			tag, err := tx.Exec(ctx, stampReleaseSQL, orgID, row.ID, time.Now().UTC().UnixMilli(), action.Passes)
			if err != nil {
				return err
			}
			if tag.RowsAffected() > 0 {
				if _, err := tx.Exec(ctx, setRowStateSQL, orgID, row.RowID, row.Revision, "none"); err != nil {
					return err
				}
			}
		case "give_up":
			if _, err := tx.Exec(ctx, stampRetrySQL, orgID, row.ID, action.Passes, action.Observation, CodeReconcileStillUnknown, int64(0)); err != nil {
				return err
			}
		default:
			if _, err := tx.Exec(ctx, stampRetrySQL, orgID, row.ID, action.Passes, action.Observation, "", action.BackoffSecs); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

const stampAcceptSQL = `
UPDATE submission_intents
SET state = 'accepted',
    last_error_code = NULL,
    reconcile_after = NULL,
    reconcile_claim_until = NULL,
    reconciliation_outcome = jsonb_set(
      COALESCE(reconciliation_outcome, '{}'::jsonb) - 'probe',
      '{found}',
      jsonb_build_object('productId', $3::bigint, 'sku', $4::bigint),
      true),
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'`

const stampReleaseSQL = `
UPDATE submission_intents
SET state = 'superseded',
    last_error_code = NULL,
    reconcile_after = NULL,
    reconcile_claim_until = NULL,
    reconciliation_outcome = jsonb_set(
      COALESCE(reconciliation_outcome, '{}'::jsonb) - 'probe',
      '{probeReleased}',
      jsonb_build_object('atMs', $3::bigint, 'passes', $4::int),
      true),
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'`

const stampRetrySQL = `
UPDATE submission_intents
SET last_error_code = CASE WHEN $5 = '' THEN last_error_code ELSE $5 END,
    reconcile_after = CASE WHEN $6::bigint <= 0 THEN NULL
         ELSE clock_timestamp() + ($6::text || ' seconds')::interval END,
    reconcile_claim_until = NULL,
    reconciliation_outcome = jsonb_set(
      COALESCE(reconciliation_outcome, '{}'::jsonb),
      '{probe}',
      jsonb_build_object('passes', $3::int, 'observation', $4::text),
      true),
    updated_at = clock_timestamp()
WHERE org_id = $1 AND id = $2::uuid AND state = 'unknown'`

const setRowStateSQL = `
UPDATE public.listing_rows
   SET submission_state = $4, updated_at = clock_timestamp()
 WHERE org_id = $1 AND id = $2::uuid AND revision = $3`
