-- +goose Up
-- declaration 208 DbObservability m20260922_160000_db_observability
-- source: migration/src/db_observability.rs @ a03d735
-- +goose StatementBegin
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
