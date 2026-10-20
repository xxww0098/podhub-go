-- +goose Up
-- +goose NO TRANSACTION
-- declaration 233 ErrorLogRetentionIdx m20260927_000415_error_log_retention_idx
-- source: migration/src/error_log_retention_idx.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "event_inbox_events_kind_received_idx" ON "public"."event_inbox_events" ("kind", "received_at", "device_uid", "id");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
