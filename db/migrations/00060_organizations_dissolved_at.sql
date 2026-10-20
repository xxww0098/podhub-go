-- +goose Up
-- declaration 60 OrganizationsDissolvedAt m20260822_000223_organizations_dissolved_at
-- source: migration/src/organizations_dissolved.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS dissolved_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS ix_organizations_live_owner
    ON public.organizations (owner_user_id)
    WHERE dissolved_at IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
