-- +goose Up
-- declaration 18 OrganizationsUuid m20260804_000046_organizations_uuid
-- source: migration/src/migrator/workspace.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS uuid uuid;

UPDATE public.organizations
SET uuid = gen_random_uuid()
WHERE uuid IS NULL;

ALTER TABLE public.organizations
    ALTER COLUMN uuid SET DEFAULT gen_random_uuid(),
    ALTER COLUMN uuid SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'organizations_uuid_key'
          AND conrelid = 'public.organizations'::regclass
    ) THEN
        ALTER TABLE public.organizations
            ADD CONSTRAINT organizations_uuid_key UNIQUE (uuid);
    END IF;
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
