-- +goose Up
-- declaration 187 LeaseKernel m20260918_000325_lease_kernel
-- source: migration/src/lease_kernel.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.lease_budget (
    namespace   text NOT NULL,
    scope       text NOT NULL,
    next_at     timestamp with time zone NOT NULL,
    expires_at  timestamp with time zone NOT NULL,
    PRIMARY KEY (namespace, scope)
);

CREATE TABLE IF NOT EXISTS public.lease_slot (
    namespace   text NOT NULL,
    scope       text NOT NULL,
    token       bytea NOT NULL,
    expires_at  timestamp with time zone NOT NULL,
    PRIMARY KEY (namespace, scope, token)
);

-- The acquire/live path counts members by `expires_at > now` per scope;
-- this index lets the count skip over the expired prefix entirely.
CREATE INDEX IF NOT EXISTS lease_slot_scope_expiry_idx
    ON public.lease_slot (namespace, scope, expires_at);

CREATE TABLE IF NOT EXISTS public.lease_window (
    namespace    text NOT NULL,
    scope        text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count        bigint NOT NULL,
    expires_at   timestamp with time zone NOT NULL,
    PRIMARY KEY (namespace, scope, window_start)
);

CREATE INDEX IF NOT EXISTS lease_budget_expiry_idx
    ON public.lease_budget (expires_at);
CREATE INDEX IF NOT EXISTS lease_window_expiry_idx
    ON public.lease_window (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lease_budget TO podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lease_slot TO podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lease_window TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
