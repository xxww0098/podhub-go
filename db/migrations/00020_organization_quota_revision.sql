-- +goose Up
-- declaration 20 OrganizationQuotaRevision m20260805_000048_organization_quota_revision
-- source: migration/src/quota_revision.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS quota_revision bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_organizations_quota_revision'
          AND conrelid = 'public.organizations'::regclass
    ) THEN
        ALTER TABLE public.organizations
            ADD CONSTRAINT ck_organizations_quota_revision CHECK (quota_revision >= 1);
    END IF;
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
