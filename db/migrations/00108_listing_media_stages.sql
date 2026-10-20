-- +goose Up
-- declaration 108 ListingMediaStages m20260905_000269_listing_media_stages
-- source: migration/src/listing_media_stages.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_rows DROP CONSTRAINT listing_rows_media_state_known;
ALTER TABLE public.listing_rows ADD CONSTRAINT listing_rows_media_state_known
 CHECK (media_state IN ('pending','processing','rendered','uploading','ready','failed'));
ALTER TABLE public.media_object_leases ADD COLUMN public_ready_at timestamptz,
 ADD COLUMN public_url text;
-- The old Job cannot prove which stage completed. Preserve media and receipts;
-- only its provisional state is reset and its execution rights are retired.
UPDATE public.listing_rows r SET media_state = 'pending', validation_state = 'stale',
 revision = revision + 1, updated_at = clock_timestamp()
WHERE media_state = 'processing' AND EXISTS (
 SELECT 1 FROM public.jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
 AND j.aggregate_type = 'listing_row' AND j.kind = 'media.prepare'
 AND j.state IN ('queued','retry_wait','running'));
UPDATE public.jobs SET state = 'cancelled', cancel_requested_at = clock_timestamp(),
 lease_owner = NULL, lease_until = NULL, last_error_code = 'media_stages_required',
 updated_at = clock_timestamp()
WHERE kind = 'media.prepare' AND state IN ('queued','retry_wait','running');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
