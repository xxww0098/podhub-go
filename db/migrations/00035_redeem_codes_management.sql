-- +goose Up
-- declaration 35 RedeemCodesManagement m20260817_000050_redeem_codes_management
-- source: migration/src/redeem_codes.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.redeem_codes
    ADD COLUMN IF NOT EXISTS batch_id uuid,
    ADD COLUMN IF NOT EXISTS note text,
    ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS created_by_user_id bigint,
    ADD COLUMN IF NOT EXISTS used_by_org_id bigint,
    ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS revoked_by_user_id bigint;

CREATE INDEX IF NOT EXISTS redeem_codes_status_idx
    ON public.redeem_codes (used, expires_at, revoked_at, created_at DESC);

CREATE INDEX IF NOT EXISTS redeem_codes_batch_idx
    ON public.redeem_codes (batch_id);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
