-- +goose Up
-- declaration 95 SellerUpstreamWritesSettlement m20260902_000253_seller_upstream_writes_settlement
-- source: migration/src/seller_upstream_writes_settlement.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.seller_upstream_writes
    DROP CONSTRAINT IF EXISTS seller_upstream_writes_state_known;

ALTER TABLE public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_state_known CHECK (state IN (
        'dispatching', 'settled', 'result_unknown', 'reconciled', 'conflict'
    ));

ALTER TABLE public.seller_upstream_writes
    ADD COLUMN IF NOT EXISTS kind             text NOT NULL DEFAULT 'proxy',
    ADD COLUMN IF NOT EXISTS request_body     jsonb,
    ADD COLUMN IF NOT EXISTS reconcile_after  timestamptz,
    ADD COLUMN IF NOT EXISTS probe_pass_count int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_observation jsonb,
    ADD COLUMN IF NOT EXISTS error_code       text,
    ADD COLUMN IF NOT EXISTS error_message    text;

-- Only a settled row carries Ozon's answer. The four other states are the
-- states in which there is no answer to carry, and saying so once is shorter
-- than enumerating them.
ALTER TABLE public.seller_upstream_writes
    DROP CONSTRAINT IF EXISTS seller_upstream_writes_response_shape;

ALTER TABLE public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_response_shape CHECK (
        (state = 'settled' AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL)
        OR
        (state <> 'settled' AND response_status IS NULL AND response_body IS NULL)
    );

CREATE INDEX IF NOT EXISTS seller_upstream_writes_due_unknown_idx
    ON public.seller_upstream_writes (reconcile_after)
    WHERE state = 'result_unknown';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
