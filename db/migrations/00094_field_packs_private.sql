-- +goose Up
-- declaration 94 FieldPacksPrivate m20260902_000252_field_packs_private
-- source: migration/src/field_packs_private.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.field_packs
    ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;

ALTER TABLE public.field_packs
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;

UPDATE public.field_packs SET shared = true WHERE NOT shared;

CREATE UNIQUE INDEX IF NOT EXISTS field_packs_one_active_per_coordinate
    ON public.field_packs (author_user_id, description_category_id, type_id, language)
    WHERE active;

CREATE INDEX IF NOT EXISTS field_packs_author_coordinate
    ON public.field_packs (
        author_user_id, description_category_id, type_id, language, updated_at_ms DESC
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
