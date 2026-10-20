-- +goose Up
-- declaration 218 WritesDispatchHeartbeat m20260923_110000_writes_dispatch_heartbeat
-- source: migration/src/writes_dispatch_heartbeat.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.seller_upstream_writes
    ADD COLUMN IF NOT EXISTS heartbeat_at_ms bigint NOT NULL
        DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint;

-- The promotion scan's own index: rows still dispatching, oldest heartbeat
-- first. Admission stamps the column via the default above, so every
-- dispatching row — including the ones the migration itself backfills — starts
-- fresh and cannot be promoted by the deploy that added the column.
CREATE INDEX IF NOT EXISTS seller_upstream_writes_dispatch_stale_idx
    ON public.seller_upstream_writes (heartbeat_at_ms)
    WHERE state = 'dispatching';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
