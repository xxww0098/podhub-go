-- +goose Up
-- declaration 81 JobCostUnitsAndLane m20260826_000243_job_cost_units_and_lane
-- source: migration/src/job_cost_units_and_lane.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS cost_units integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT '';

UPDATE public.jobs
   SET lane = kind
 WHERE lane = '';

UPDATE public.jobs
   SET cost_units = CASE kind
       WHEN 'ai.recognize' THEN 8
       WHEN 'media.prepare' THEN 8
       WHEN 'listing.submit' THEN 4
       WHEN 'listing.submit.batch' THEN 4
       WHEN 'listing.reconcile' THEN 2
       ELSE 1
   END;

ALTER TABLE public.jobs
    DROP CONSTRAINT IF EXISTS jobs_cost_units_pos;
ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_cost_units_pos CHECK (cost_units > 0);

CREATE INDEX IF NOT EXISTS jobs_lease_expiry_kind_idx
    ON public.jobs (kind, lease_until)
    WHERE state = 'running';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
