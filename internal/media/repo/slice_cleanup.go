package mediarepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Every frozen use must have an exact picture receipt older than the retry
// window. Pending jobs and other live references keep shared slices alive.
const fetchedSliceEligible = `l.org_id=$2 AND l.media_account_id=$1
 AND public.media_gc_image_identity(l.object_key)=$1||':'||l.content_hash
 AND l.retired_at IS NULL AND l.deleted_at IS NULL AND l.gc_claim_token IS NULL
 AND l.slice_gc_tracked AND l.verification_status='verified' AND l.public_ready_at IS NOT NULL
 AND l.first_seen_at<$3 AND l.expires_at<=clock_timestamp()
 AND l.last_hit_at<=clock_timestamp()-interval '16 minutes'
 AND EXISTS(SELECT 1 FROM public.submission_intents i WHERE i.org_id=$2
   AND i.slice_image_urls @> ARRAY[l.public_url] AND i.slice_images_fetched_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.submission_intents i WHERE i.org_id=$2
   AND i.slice_image_urls @> ARRAY[l.public_url]
   AND (i.slice_images_fetched_at IS NULL OR i.slice_images_fetched_at>clock_timestamp()-interval '24 hours'))
 AND NOT EXISTS(SELECT 1 FROM public.listing_rows r WHERE r.org_id=$2
   AND (r.submission_state IN ('queued','submitting','unknown')
     OR (r.media_state='ready' AND r.submission_state NOT IN ('accepted','cancelled')))
   AND position(l.object_key in r.payload::text)>0)
 AND NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.org_id=$2
   AND j.state IN ('queued','running','retry_wait','uncertain') AND position(l.object_key in j.payload::text)>0)
 AND NOT EXISTS(SELECT 1 FROM public.store_products p WHERE p.org_id=$2 AND p.gone_at_ms IS NULL
   AND position(l.object_key in COALESCE(p.primary_image,''))>0)
 AND NOT EXISTS(SELECT 1 FROM public.supplier_media_objects s
   WHERE s.object_key=l.object_key OR (l.public_url<>'' AND s.public_url=l.public_url))
 AND NOT EXISTS(SELECT 1 FROM public.media_blobs b WHERE b.org_id=$2 AND b.state<>'deleted' AND b.storage_key=l.object_key)
 AND NOT EXISTS(SELECT 1 FROM public.media_uploads u WHERE u.org_id=$2 AND u.state='pending'
   AND u.expires_at>clock_timestamp() AND u.storage_key=l.object_key)`

// RetireFetchedSlices runs in a worker transaction. No lock spans an R2 call.
func RetireFetchedSlices(ctx context.Context, tx pgx.Tx, orgID int64, storageID string, before time.Time, keys []string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('workspace-slice-storage:'||$1::bigint::text,0))`, orgID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `WITH candidates AS MATERIALIZED (
 SELECT DISTINCT l.content_hash FROM public.media_object_leases l
 WHERE `+fetchedSliceEligible+` AND l.object_key=ANY($4::text[])
 AND md5(l.object_key)=ANY(ARRAY(SELECT md5(k) FROM unnest($4::text[]) k)) ORDER BY l.content_hash
 ), locked AS MATERIALIZED (
 SELECT content_hash,pg_try_advisory_xact_lock(hashtextextended(
 'podhub:media-reference:v1:'||$1||':'||content_hash,0)) AS acquired FROM candidates
 ) SELECT content_hash FROM locked WHERE acquired`, storageID, orgID, before, keys)
	if err != nil {
		return err
	}
	var digests []string
	for rows.Next() {
		var digest string
		if err := rows.Scan(&digest); err != nil {
			rows.Close()
			return err
		}
		digests = append(digests, digest)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(digests) == 0 {
		return nil
	}
	// A separate statement after draining the fences observes committed writers.
	_, err = tx.Exec(ctx, `UPDATE public.media_object_leases l SET retired_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE `+fetchedSliceEligible+` AND l.object_key=ANY($4::text[]) AND l.content_hash=ANY($5::text[])`, storageID, orgID, before, keys, digests)
	return err
}

// RetiredSliceKeys filters an upstream page; unknown or still-live keys stay.
func RetiredSliceKeys(ctx context.Context, tx pgx.Tx, orgID int64, storageID string, keys []string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT l.object_key FROM public.media_object_leases l
 WHERE l.org_id=$1 AND l.media_account_id=$2 AND l.object_key=ANY($3::text[])
 AND md5(l.object_key)=ANY(ARRAY(SELECT md5(k) FROM unnest($3::text[]) k))
 AND l.retired_at IS NOT NULL AND l.last_hit_at<=clock_timestamp()-interval '16 minutes'
 AND NOT EXISTS(SELECT 1 FROM public.media_object_leases other WHERE other.object_key=l.object_key
   AND public.media_gc_image_identity(other.object_key)=public.media_gc_image_identity(l.object_key)
   AND other.media_account_id=$2 AND other.retired_at IS NULL AND other.deleted_at IS NULL)`, orgID, storageID, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, rows.Err()
}
