-- +goose Up
-- declaration 221 CatalogDictionarySearchMaterial m20260924_000403_catalog_dictionary_search_material
-- source: migration/src/catalog_dictionary_search_material.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.catalog_dictionary_search_material (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    attribute_id bigint NOT NULL,
    dictionary_id bigint NOT NULL,
    option_id bigint NOT NULL,
    value text NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (description_category_id, type_id, language, attribute_id, dictionary_id, option_id),
    CHECK (description_category_id > 0 AND type_id > 0 AND attribute_id > 0
           AND dictionary_id > 0 AND option_id > 0),
    CHECK (language IN ('default', 'ru', 'en', 'tr', 'zh_hans')),
    CHECK (length(value) > 0)
);
GRANT SELECT, INSERT, UPDATE ON TABLE public.catalog_dictionary_search_material
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
