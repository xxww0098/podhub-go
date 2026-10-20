-- +goose Up
-- declaration 26 StoreLimitOverride m20260805_000054_store_limit_override
-- source: migration/src/store_limit_override.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS store_limit_override bigint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_organizations_store_limit_override'
          AND conrelid = 'public.organizations'::regclass
    ) THEN
        ALTER TABLE public.organizations
            ADD CONSTRAINT ck_organizations_store_limit_override
                CHECK (store_limit_override IS NULL OR store_limit_override >= 1) NOT VALID;
    END IF;
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
