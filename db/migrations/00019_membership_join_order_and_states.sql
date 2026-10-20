-- +goose Up
-- +goose NO TRANSACTION
-- declaration 19 MembershipJoinOrderAndStates m20260805_000047_membership_join_order_and_states
-- source: migration/src/membership.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_members
    ADD COLUMN IF NOT EXISTS join_order bigint,
    ADD COLUMN IF NOT EXISTS manual_disabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS quota_suspended boolean NOT NULL DEFAULT false;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.organization_members AS m
SET join_order = ranked.seq
FROM (
    SELECT id,
           row_number() OVER (
               PARTITION BY org_id
               ORDER BY (role = 'owner') DESC, created_at ASC, id ASC
           )::bigint AS seq
    FROM public.organization_members
) AS ranked
WHERE m.id = ranked.id;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.organization_members
SET manual_disabled = (role <> 'owner'),
    quota_suspended = CASE WHEN role = 'owner' THEN false ELSE quota_suspended END,
    status = 'active'
WHERE status <> 'active';
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.organization_members
    ALTER COLUMN join_order SET NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.organization_members
    DROP CONSTRAINT IF EXISTS ck_organization_members_status;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.organization_members
    ADD CONSTRAINT ck_organization_members_status CHECK (status::text = 'active');
-- +goose StatementEnd
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_organization_members_join_order'
          AND conrelid = 'public.organization_members'::regclass
    ) THEN
        ALTER TABLE public.organization_members
            ADD CONSTRAINT ck_organization_members_join_order CHECK (join_order >= 1);
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_organization_members_owner_protected'
          AND conrelid = 'public.organization_members'::regclass
    ) THEN
        ALTER TABLE public.organization_members
            ADD CONSTRAINT ck_organization_members_owner_protected CHECK (
                role <> 'owner' OR (NOT manual_disabled AND NOT quota_suspended)
            );
    END IF;
END
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "uq_org_members_join_order" ON "public"."organization_members" ("org_id", "join_order");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
