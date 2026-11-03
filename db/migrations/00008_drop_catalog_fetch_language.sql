-- +goose Up
-- The category fetch always downloads the Chinese (zh_hans) variant, so the
-- configurable language has no reader left.
ALTER TABLE public.platform_catalog_fetch_config DROP COLUMN language;

-- +goose Down
ALTER TABLE public.platform_catalog_fetch_config ADD COLUMN language character varying(16) DEFAULT 'zh_hans'::character varying NOT NULL;
