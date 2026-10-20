-- +goose Up
-- declaration 99 CardPackages m20260903_000262_card_packages
-- source: migration/src/card_packages.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.card_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author_user_id bigint NOT NULL,
    source_card_id uuid,
    name text NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    payload jsonb NOT NULL,
    listed boolean NOT NULL DEFAULT false,
    updated_at_ms bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS card_packages_author_source
    ON public.card_packages (author_user_id, source_card_id)
    WHERE source_card_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS card_packages_listed_updated
    ON public.card_packages (listed, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS card_packages_author_updated
    ON public.card_packages (author_user_id, updated_at_ms DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.card_packages
    TO podhub_app;

ALTER TABLE public.card_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_packages_author_isolation ON public.card_packages;
CREATE POLICY card_packages_author_isolation ON public.card_packages
    FOR ALL TO podhub_app
    USING (author_user_id = NULLIF(current_setting('app.current_user_id', true), '')::bigint)
    WITH CHECK (author_user_id = NULLIF(current_setting('app.current_user_id', true), '')::bigint);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
