-- +goose Up
-- +goose StatementBegin
-- Daily transit-bucket clear receipts. One row per bucket identity per
-- Shanghai day. There is no closing window: the first claim at or after 04:00
-- Asia/Shanghai owns the run, and it stays claimable until the bucket is
-- observed empty. The identity excludes credentials and account aliases, so
-- renaming an account does not reset the day's continuity.
CREATE TABLE public.transit_clear_runs (
    bucket_identity text NOT NULL CHECK (bucket_identity ~ '^[0-9a-f]{64}$'),
    run_day date NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'partial', 'completed')),
    lease_token uuid,
    lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
    lease_until timestamptz,
    started_at timestamptz NOT NULL,
    next_attempt_at timestamptz NOT NULL,
    api_calls integer NOT NULL DEFAULT 0 CHECK (api_calls BETWEEN 0 AND 1000000),
    api_results integer NOT NULL DEFAULT 0 CHECK (api_results BETWEEN 0 AND api_calls),
    last_result_call integer NOT NULL DEFAULT 0 CHECK (last_result_call BETWEEN 0 AND api_calls),
    deleted_acked bigint NOT NULL DEFAULT 0 CHECK (deleted_acked >= 0),
    failed_objects bigint NOT NULL DEFAULT 0 CHECK (failed_objects >= 0),
    last_api_at timestamptz,
    error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    completed_at timestamptz,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_identity, run_day),
    -- The run day is the Shanghai date of a 04:00 boundary and the run never
    -- starts before it. Late claims (a `partial` retry) are allowed.
    CONSTRAINT transit_clear_started_after_boundary CHECK (
        started_at >= (run_day + time '04:00') AT TIME ZONE 'Asia/Shanghai'
    ),
    CONSTRAINT transit_clear_lease CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_until IS NULL)
    ),
    CONSTRAINT transit_clear_completion CHECK (
        (status = 'completed') = (completed_at IS NOT NULL)
    )
);
COMMENT ON TABLE public.transit_clear_runs IS
    'Transit bucket daily clear receipts: no tenant identifiers and no object keys.';
REVOKE ALL ON public.transit_clear_runs FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE ON public.transit_clear_runs TO podhub_app;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
