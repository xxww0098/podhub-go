-- +goose Up
-- +goose NO TRANSACTION
-- declaration 13 DevicesTokenHashUidx m20260802_000041_devices_token_hash_uidx
-- source: migration/src/idempotency.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "devices_token_hash_uidx" ON "public"."devices" ("token_hash");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
