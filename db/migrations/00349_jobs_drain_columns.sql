-- +goose Up
-- +goose StatementBegin
-- Drain needs to know which store and which member a job belongs to. Without
-- these a draining workspace can only be suspended as a whole, which would
-- stop tasks the user was told would finish.
ALTER TABLE public.jobs
    ADD COLUMN store_id  uuid REFERENCES public.organization_stores (uuid) ON DELETE SET NULL,
    ADD COLUMN member_id bigint REFERENCES public.organization_members (id) ON DELETE SET NULL;

-- The suspend check is a per-store EXISTS over live rows.
CREATE INDEX jobs_drain_store_idx
    ON public.jobs (org_id, store_id)
    WHERE state IN ('queued', 'retry_wait', 'running');
CREATE INDEX jobs_drain_member_idx
    ON public.jobs (org_id, member_id)
    WHERE state IN ('queued', 'retry_wait', 'running');

-- Old rows keep NULL: a job with no store does not block any single store.
-- That is the correct reading for delegate and sync jobs, which act on the
-- workspace as a whole.
COMMENT ON COLUMN public.jobs.store_id IS
    'Store the job writes through, when it has one. NULL blocks no store during a drain.';
COMMENT ON COLUMN public.jobs.member_id IS
    'Member who submitted the work, when known. NULL blocks no member during a drain.';
-- +goose StatementEnd
-- +goose Down
SELECT 1;
