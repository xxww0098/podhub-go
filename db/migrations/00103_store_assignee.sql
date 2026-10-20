-- +goose Up
-- declaration 103 StoreAssignee m20260904_000263_store_assignee
-- source: migration/src/store_assignee.rs @ a03d735
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'organization_stores'
          AND column_name = 'owned_by_membership_id'
    ) THEN
        ALTER TABLE public.organization_stores
            RENAME COLUMN owned_by_membership_id TO assignee_membership_id;
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'organization_stores_owned_by_membership_id_fkey'
          AND conrelid = 'public.organization_stores'::regclass
    ) THEN
        ALTER TABLE public.organization_stores
            RENAME CONSTRAINT organization_stores_owned_by_membership_id_fkey
            TO organization_stores_assignee_membership_id_fkey;
    END IF;
END
$$;

ALTER INDEX IF EXISTS public.ix_organization_stores_owner
    RENAME TO ix_organization_stores_assignee;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
