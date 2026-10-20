-- +goose Up
-- declaration 126 ShippingInjectDiagnostics m20260906_000286_shipping_inject_diagnostics
-- source: migration/src/shipping_inject_diagnostics.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.shipping_shop_injections
    ADD COLUMN IF NOT EXISTS remote_absent_at_ms bigint;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
