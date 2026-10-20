-- +goose Up
-- declaration 66 CardFieldDefaults m20260819_000203_card_field_defaults
-- source: migration/src/card_field_defaults.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.card_field_defaults (
    org_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    defaults_json text NOT NULL,
    updated_at_ms bigint NOT NULL,
    updated_by_user_id bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (org_id, description_category_id, type_id, language)
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
