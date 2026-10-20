-- +goose Up
-- declaration 30 AccountUserProfileSplit m20260813_000058_account_user_profile_split
-- source: migration/src/account_user_split.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.account_credentials (
    user_id bigint PRIMARY KEY
        REFERENCES public.account_users(id) ON DELETE CASCADE,
    password_hash character varying(255) NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS public.account_profiles (
    user_id bigint PRIMARY KEY
        REFERENCES public.account_users(id) ON DELETE CASCADE,
    name character varying(255) NOT NULL,
    target character varying(64) DEFAULT '/workspace'::character varying NOT NULL,
    supplier_id character varying(64) DEFAULT ''::character varying NOT NULL,
    active_org_id bigint,
    updated_at timestamp with time zone NOT NULL
);

INSERT INTO public.account_credentials (user_id, password_hash, updated_at)
SELECT id, password_hash, updated_at
FROM public.account_users
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.account_profiles (
    user_id, name, target, supplier_id, active_org_id, updated_at
)
SELECT id, name, target, supplier_id, active_org_id, updated_at
FROM public.account_users
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.sync_account_side_tables()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.account_credentials (user_id, password_hash, updated_at)
    VALUES (NEW.id, NEW.password_hash, NEW.updated_at)
    ON CONFLICT (user_id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO public.account_profiles (
        user_id, name, target, supplier_id, active_org_id, updated_at
    )
    VALUES (
        NEW.id, NEW.name, NEW.target, NEW.supplier_id, NEW.active_org_id, NEW.updated_at
    )
    ON CONFLICT (user_id) DO UPDATE SET
        name = EXCLUDED.name,
        target = EXCLUDED.target,
        supplier_id = EXCLUDED.supplier_id,
        active_org_id = EXCLUDED.active_org_id,
        updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_users_sync_side_tables ON public.account_users;
CREATE TRIGGER account_users_sync_side_tables
AFTER INSERT OR UPDATE OF password_hash, name, target, supplier_id,
    active_org_id, updated_at
ON public.account_users
FOR EACH ROW
EXECUTE FUNCTION public.sync_account_side_tables();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
