-- +goose Up
ALTER TABLE public.workspace_slice_storage
    ADD COLUMN clear_at_minute integer DEFAULT 240 CHECK (clear_at_minute BETWEEN 0 AND 1439),
    ADD COLUMN clear_configured_at timestamptz NOT NULL DEFAULT '2000-01-01 00:00:00+00',
    ADD COLUMN clear_fence_at timestamptz;
ALTER TABLE public.workspace_slice_storage ALTER COLUMN clear_configured_at SET DEFAULT clock_timestamp();

ALTER TABLE public.transit_clear_runs ADD COLUMN boundary_at timestamptz;
UPDATE public.transit_clear_runs SET boundary_at=(run_day + time '04:00') AT TIME ZONE 'Asia/Shanghai';
UPDATE public.workspace_slice_storage s SET clear_fence_at=(
    SELECT max(r.boundary_at) FROM public.transit_clear_runs r
    WHERE r.bucket_identity=encode(public.digest('user-slice-clear:daily:' || s.id::text, 'sha256'), 'hex')
);
ALTER TABLE public.transit_clear_runs ALTER COLUMN boundary_at SET NOT NULL;
ALTER TABLE public.transit_clear_runs DROP CONSTRAINT transit_clear_started_after_boundary;
ALTER TABLE public.transit_clear_runs ADD CONSTRAINT transit_clear_started_after_boundary CHECK (started_at >= boundary_at);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'Custom cleanup schedules cannot be reverted to a fixed schedule without review';
END $$;
-- +goose StatementEnd
