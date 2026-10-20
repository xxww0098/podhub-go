-- +goose Up
-- +goose NO TRANSACTION
-- declaration 29 DevicesUserFingerprintUidx m20260811_000057_devices_user_fingerprint_uidx
-- source: migration/src/idempotency.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "devices_user_fingerprint_uidx" ON "public"."devices" ("user_id", "fingerprint");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
