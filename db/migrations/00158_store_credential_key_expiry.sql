-- +goose Up
-- declaration 158 StoreCredentialKeyExpiry m20260914_000302_store_credential_key_expiry
-- source: migration/src/store_credential_key_expiry.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_seller_credentials
    ADD COLUMN IF NOT EXISTS key_expires_at_ms bigint;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
