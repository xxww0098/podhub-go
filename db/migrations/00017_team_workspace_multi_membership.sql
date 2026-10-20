-- +goose Up
-- declaration 17 TeamWorkspaceMultiMembership m20260803_000045_team_workspace_multi_membership
-- source: migration/src/migrator/workspace.rs @ a03d735
-- +goose StatementBegin
DROP INDEX IF EXISTS public.uq_org_members_active_user;

ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS active_org_id bigint;

UPDATE public.account_users u
SET active_org_id = COALESCE(
        (
            SELECT o.id
            FROM public.organizations o
            WHERE o.owner_user_id = u.id
            LIMIT 1
        ),
        (
            SELECT m.org_id
            FROM public.organization_members m
            WHERE m.user_id = u.id AND m.status = 'active'
            ORDER BY m.org_id ASC
            LIMIT 1
        )
    )
WHERE u.active_org_id IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
