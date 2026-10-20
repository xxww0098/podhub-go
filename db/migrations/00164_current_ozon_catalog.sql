-- +goose Up
-- declaration 164 CurrentOzonCatalog m20260914_000307_current_ozon_catalog
-- source: migration/src/current_ozon_catalog.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.ozon_category_current (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) NOT NULL,
    fields jsonb NOT NULL,
    content_digest character varying(71) NOT NULL,
    fetched_at_ms bigint NOT NULL,
    refresh_status character varying(16) NOT NULL DEFAULT 'complete',
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ozon_category_current_pkey
        PRIMARY KEY (description_category_id, type_id, language),
    CONSTRAINT ozon_category_current_coordinate_positive
        CHECK (description_category_id > 0 AND type_id > 0),
    CONSTRAINT ozon_category_current_language_known
        CHECK (language IN ('default', 'ru', 'en', 'tr', 'zh_hans')),
    CONSTRAINT ozon_category_current_fields_array
        CHECK (jsonb_typeof(fields) = 'array'),
    CONSTRAINT ozon_category_current_digest_shape
        CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ozon_category_current_refresh_complete
        CHECK (refresh_status = 'complete')
);

CREATE TABLE IF NOT EXISTS public.ozon_dictionary_current (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) NOT NULL,
    attribute_id bigint NOT NULL,
    option_id bigint NOT NULL,
    value text NOT NULL,
    info text NOT NULL DEFAULT '',
    picture text NOT NULL DEFAULT '',
    CONSTRAINT ozon_dictionary_current_pkey
        PRIMARY KEY (description_category_id, type_id, language, attribute_id, option_id),
    CONSTRAINT ozon_dictionary_current_category_fkey
        FOREIGN KEY (description_category_id, type_id, language)
        REFERENCES public.ozon_category_current
            (description_category_id, type_id, language)
        ON DELETE CASCADE,
    CONSTRAINT ozon_dictionary_current_identity_positive
        CHECK (attribute_id > 0 AND option_id > 0)
);

ALTER TABLE public.platform_catalog_fetch_config
    ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE public.platform_catalog_fetch_config
    ADD CONSTRAINT platform_catalog_fetch_config_lease_epoch_nonnegative
    CHECK (lease_epoch >= 0);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
