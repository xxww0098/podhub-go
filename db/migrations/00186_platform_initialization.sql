-- +goose Up
-- declaration 186 PlatformInitialization m20260917_000324_platform_initialization
-- source: migration/src/platform_initialization.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.platform_initialization (
    singleton boolean PRIMARY KEY DEFAULT true,
    owner_account_id bigint REFERENCES public.account_users(id),
    initialized_at timestamp with time zone,
    CONSTRAINT platform_initialization_singleton CHECK (singleton),
    CONSTRAINT platform_initialization_owner_pair CHECK (
        (owner_account_id IS NULL) = (initialized_at IS NULL)
    )
);

INSERT INTO public.platform_initialization (singleton) VALUES (true) ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_initialization TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
