-- +goose Up
-- declaration 113 ListingTaskOwnership m20260905_000274_listing_task_ownership
-- source: migration/src/listing_task_ownership.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS input_fingerprint text;
CREATE INDEX IF NOT EXISTS jobs_org_input_fingerprint_idx
    ON public.jobs (org_id, input_fingerprint)
    WHERE input_fingerprint IS NOT NULL;

ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id),
    ADD COLUMN IF NOT EXISTS input_fingerprint text,
    ADD COLUMN IF NOT EXISTS authorized_units bigint,
    ADD COLUMN IF NOT EXISTS binding_hash text,
    ADD COLUMN IF NOT EXISTS binding_status text;
ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_binding_status_known;
ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_binding_status_known
    CHECK (binding_status IS NULL OR binding_status IN ('bound', 'legacy_unverified'));
CREATE INDEX IF NOT EXISTS ai_requests_org_job_idx
    ON public.ai_requests (org_id, job_id)
    WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_requests_org_binding_hash_idx
    ON public.ai_requests (org_id, binding_hash)
    WHERE binding_hash IS NOT NULL;

UPDATE public.ai_requests
   SET binding_status = 'legacy_unverified'
 WHERE binding_hash IS NULL AND binding_status IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
