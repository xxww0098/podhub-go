-- +goose Up
-- declaration 51 IdentityAvatars m20260820_000214_identity_avatars
-- source: migration/src/avatars.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.account_profiles
    ADD COLUMN IF NOT EXISTS avatar_bytes bytea,
    ADD COLUMN IF NOT EXISTS avatar_updated_at_ms bigint;

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS avatar_bytes bytea,
    ADD COLUMN IF NOT EXISTS avatar_updated_at_ms bigint;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
