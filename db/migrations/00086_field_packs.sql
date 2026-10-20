-- +goose Up
-- declaration 86 FieldPacks m20260827_000245_field_packs
-- source: migration/src/field_packs.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.field_packs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author_user_id bigint NOT NULL,
    name text NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    defaults_json text NOT NULL,
    updated_at_ms bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS field_packs_coordinate_updated
    ON public.field_packs (
        description_category_id, type_id, language, updated_at_ms DESC
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.field_packs
    TO podhub_app;

DROP TABLE IF EXISTS public.card_field_defaults;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
