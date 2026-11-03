package readrepo

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
)

// TaskRecords reads existing receipts and jobs; it never creates or retries work.
func TaskRecords(ctx context.Context, tx pgx.Tx, orgID, userID, membershipID int64, manageAll bool, f domain.TaskRecordFilter) (domain.TaskRecordsPage, error) {
	rows, err := tx.Query(ctx, `
WITH visible_stores AS (
 SELECT uuid, name FROM organization_stores
 WHERE org_id=$1 AND deleted_at_ms IS NULL AND ($4::boolean OR assignee_membership_id=$3)
), records AS (
 SELECT i.id, 'listing'::text AS kind, i.store_id, s.name AS store_name,
        COALESCE(NULLIF(c.title,''),i.offer_id,'商品上架') AS title,
        c.id AS card_id, i.listing_row_id AS row_id, i.state,
        COALESCE(i.last_error_code,'') AS error_code, i.external_task_id,
        NULL::integer AS attempt, i.reconcile_after AS next_attempt_at, i.created_at, i.updated_at
 FROM submission_intents i
 JOIN visible_stores s ON s.uuid=i.store_id
 LEFT JOIN listing_rows r ON r.org_id=i.org_id AND r.id=i.listing_row_id
 LEFT JOIN listing_cards c ON c.org_id=i.org_id AND c.id=COALESCE(i.card_id,r.card_id)
 WHERE i.org_id=$1
 UNION ALL
 SELECT j.id, CASE WHEN j.kind='store.product_sync' THEN 'product_sync' ELSE 'media' END,
        COALESCE(j.store_id,r.store_id,CASE WHEN j.aggregate_type='store_product_sync' THEN j.aggregate_id END),
        COALESCE(s.name,''), COALESCE(NULLIF(c.title,''),CASE j.kind
          WHEN 'store.product_sync' THEN '商品同步'
          WHEN 'media.render' THEN '商品切片'
          WHEN 'media.upload' THEN '图片上传'
          ELSE 'AI 识图' END),
        c.id, r.id, j.state, COALESCE(j.last_error_code,''), NULL::text,
        j.attempt, CASE WHEN j.state IN ('queued','retry_wait') THEN j.run_at END,
        j.created_at,j.updated_at
 FROM jobs j
 LEFT JOIN listing_rows r ON r.org_id=j.org_id AND j.aggregate_type='listing_row' AND r.id=j.aggregate_id
 LEFT JOIN listing_cards c ON c.org_id=j.org_id AND c.id=r.card_id
 LEFT JOIN visible_stores s ON s.uuid=COALESCE(j.store_id,r.store_id,CASE WHEN j.aggregate_type='store_product_sync' THEN j.aggregate_id END)
 WHERE j.org_id=$1 AND j.kind IN ('store.product_sync','media.render','media.upload','ai.recognize')
   AND (s.uuid IS NOT NULL OR (
     COALESCE(j.store_id,r.store_id,CASE WHEN j.aggregate_type='store_product_sync' THEN j.aggregate_id END) IS NULL
     AND r.id IS NOT NULL AND ($4::boolean OR j.submitter_user_id=$2)))
)
SELECT id::text,kind,store_id::text,store_name,title,card_id::text,row_id::text,state,
       error_code,external_task_id,attempt,next_attempt_at,created_at,updated_at
FROM records
WHERE ($5::text='' OR store_id::text=$5) AND ($6::text='' OR kind=$6)
 AND ($7::text=''
   OR ($7='active' AND state IN ('queued','submitting','running','retry_wait'))
   OR ($7='attention' AND (state IN ('unknown','uncertain','rejected','failed','conflict')
       OR (error_code<>'' AND state NOT IN ('cancelled','superseded','reconciled','operator_attested'))))
   OR ($7='finished' AND state IN ('accepted','reconciled','operator_attested','superseded','succeeded'))
   OR ($7='cancelled' AND state='cancelled'))
 AND ($8::bigint=0 OR (created_at,id)<(TIMESTAMPTZ 'epoch'+$8::bigint*INTERVAL '1 microsecond',NULLIF($9::text,'')::uuid))
ORDER BY created_at DESC,id DESC LIMIT $10`, orgID, userID, membershipID, manageAll,
		f.StoreID, f.Kind, f.Status, f.CursorMicros, f.CursorID, f.Limit+1)
	if err != nil {
		return domain.TaskRecordsPage{}, err
	}
	defer rows.Close()
	page := domain.TaskRecordsPage{Items: []domain.TaskRecord{}}
	for rows.Next() {
		var item domain.TaskRecord
		if err := rows.Scan(&item.ID, &item.Kind, &item.StoreID, &item.StoreName, &item.Title,
			&item.CardID, &item.RowID, &item.State, &item.ErrorCode, &item.ExternalTaskID,
			&item.Attempt, &item.NextAttemptAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return domain.TaskRecordsPage{}, err
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return domain.TaskRecordsPage{}, err
	}
	rows.Close()
	if len(page.Items) > f.Limit {
		page.Items = page.Items[:f.Limit]
		last := page.Items[len(page.Items)-1]
		cursor := domain.FormatCursor(last.CreatedAt.UnixMicro(), last.ID)
		page.NextCursor = &cursor
	}
	if err := hydrateListingAttempts(ctx, tx, orgID, page.Items); err != nil {
		return domain.TaskRecordsPage{}, err
	}
	return page, nil
}

// Resolve only this page, and match the current payload after a batch was split.
func hydrateListingAttempts(ctx context.Context, tx pgx.Tx, orgID int64, items []domain.TaskRecord) error {
	ids, contained := []string{}, []string{}
	indexes := make(map[string]int, len(items))
	for i, item := range items {
		if item.Kind != "listing" {
			continue
		}
		ids = append(ids, item.ID)
		raw, err := json.Marshal([]map[string]string{{"intentId": item.ID}})
		if err != nil {
			return err
		}
		contained = append(contained, string(raw))
		indexes[item.ID] = i
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `WITH candidates AS MATERIALIZED (
	 SELECT id,payload,aggregate_id,kind,attempt,state,run_at,created_at,updated_at FROM public.jobs
	 WHERE org_id=$1 AND (
	   (kind='listing.submit' AND (aggregate_id=ANY($2::uuid[]) OR payload->>'intentId'=ANY($3::text[])))
	   OR (kind='listing.submit.batch' AND payload->'intents' @> ANY($4::jsonb[])))
	)
	SELECT DISTINCT ON (i.id) i.id::text,j.attempt,j.state,j.run_at
	FROM public.submission_intents i JOIN candidates j ON (
	 (j.kind='listing.submit' AND (j.aggregate_id=i.id OR j.payload->>'intentId'=i.id::text)
	  AND j.payload->>'rowRevision'=i.row_revision::text AND j.payload->>'requestHash'=i.request_hash)
	 OR (j.kind='listing.submit.batch' AND j.payload->'intents' @> jsonb_build_array(jsonb_build_object(
	   'intentId',i.id::text,'rowRevision',i.row_revision,'requestHash',i.request_hash))))
	WHERE i.org_id=$1 AND i.id=ANY($2::uuid[])
	ORDER BY i.id,(j.state IN ('queued','running','retry_wait','uncertain')) DESC,j.created_at DESC,j.updated_at DESC,j.id DESC`, orgID, ids, ids, contained)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, state string
		var attempt int
		var at time.Time
		if err := rows.Scan(&id, &attempt, &state, &at); err != nil {
			return err
		}
		i := indexes[id]
		items[i].Attempt = &attempt
		if (items[i].State == "queued" || items[i].State == "submitting") && (state == "queued" || state == "retry_wait") {
			items[i].NextAttemptAt = &at
		}
	}
	return rows.Err()
}
