-- +goose Up
-- declaration 274 StoreFinanceBalance m20261013_000054_store_finance_balance
-- source: migration/src/store_finance_balance.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS finance_balance jsonb;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
