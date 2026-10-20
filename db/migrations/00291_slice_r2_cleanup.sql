-- +goose Up
-- declaration 291 SliceR2Cleanup m20261015_000064_slice_r2_cleanup
-- source: migration/src/slice_r2_cleanup.rs @ a03d735
-- +goose StatementBegin
-- Global physical infrastructure, not a tenant resource: deliberately no org_id
-- or tenant RLS. Only the Cloud runtime role can mutate these bounded receipts.
-- The physical fingerprint excludes credentials/config revision/account aliases.
CREATE TABLE public.slice_r2_cleanup_runs (
    bucket_fingerprint text NOT NULL CHECK (bucket_fingerprint ~ '^[0-9a-f]{64}$'),
    run_day date NOT NULL,
    status text NOT NULL CHECK (status IN ('running','partial','completed')),
    lease_token uuid,
    lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
    lease_until timestamptz,
    started_at timestamptz NOT NULL,
    window_deadline timestamptz NOT NULL,
    next_attempt_at timestamptz NOT NULL,
    api_calls integer NOT NULL DEFAULT 0 CHECK (api_calls BETWEEN 0 AND 10000),
    api_results integer NOT NULL DEFAULT 0 CHECK (api_results BETWEEN 0 AND api_calls),
    last_result_call integer NOT NULL DEFAULT 0 CHECK (last_result_call BETWEEN 0 AND api_calls),
    deleted_acked bigint NOT NULL DEFAULT 0 CHECK (deleted_acked >= 0),
    failed_objects bigint NOT NULL DEFAULT 0 CHECK (failed_objects >= 0),
    last_api_at timestamptz,
    error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    completed_at timestamptz,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_fingerprint, run_day),
    CONSTRAINT slice_cleanup_window CHECK (
        window_deadline = (run_day + time '04:30') AT TIME ZONE 'Asia/Shanghai'
        AND started_at >= (run_day + time '04:00') AT TIME ZONE 'Asia/Shanghai'
        AND started_at < window_deadline
    ),
    CONSTRAINT slice_cleanup_lease CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_until IS NULL)
    ),
    CONSTRAINT slice_cleanup_lease_window CHECK (lease_until <= window_deadline),
    CONSTRAINT slice_cleanup_completion CHECK (
        (status = 'completed') = (completed_at IS NOT NULL)
    )
);
COMMENT ON TABLE public.slice_r2_cleanup_runs IS
    'Platform bucket/day cleanup receipts: no tenant identifiers or object keys; shared physical bucket exclusion, daily prepaid API cap, and upload readiness fence.';
REVOKE ALL ON public.slice_r2_cleanup_runs FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE ON public.slice_r2_cleanup_runs TO podhub_app;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
