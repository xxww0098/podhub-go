-- +goose Up
-- declaration 251 RetireStoreExecutionGrantsFamily m20260930_000434_retire_store_execution_grants_family
-- source: migration/src/retire_store_execution_grants_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.store_execution_grants;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
