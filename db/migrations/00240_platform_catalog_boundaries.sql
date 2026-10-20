-- +goose Up
-- declaration 240 PlatformCatalogBoundaries m20260930_000423_platform_catalog_boundaries
-- source: migration/src/platform_catalog_boundaries.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_field_templates RENAME TO ozon_listing_field_templates;
ALTER TABLE public.listing_schema_snapshots RENAME TO ozon_listing_schema_snapshots;
ALTER TABLE public.catalog_tree_cache RENAME TO ozon_catalog_tree_cache;
ALTER TABLE public.catalog_schema_cache RENAME TO ozon_catalog_schema_cache;
ALTER TABLE public.field_packs RENAME TO ozon_field_packs;

-- The old official recipe key is opaque, unlike the current category/type key.
-- Bind it to its actual Ozon snapshot rather than guessing numeric coordinates.
ALTER TABLE public.ozon_listing_schema_snapshots
    ADD CONSTRAINT ozon_schema_snapshot_identity UNIQUE (id, category_id);
ALTER TABLE public.ozon_listing_field_templates ADD COLUMN schema_snapshot_id bigint;
UPDATE public.ozon_listing_field_templates AS recipe
SET schema_snapshot_id = (
    SELECT snapshot.id FROM public.ozon_listing_schema_snapshots AS snapshot
    WHERE snapshot.category_id = recipe.category_id
    ORDER BY snapshot.updated_at_ms DESC, snapshot.id DESC LIMIT 1
);
ALTER TABLE public.ozon_listing_field_templates
    ADD CONSTRAINT ozon_recipe_schema_snapshot
        FOREIGN KEY (schema_snapshot_id, category_id)
        REFERENCES public.ozon_listing_schema_snapshots (id, category_id),
    ADD CONSTRAINT ozon_official_recipe_has_schema
        CHECK (scope <> 'official' OR schema_snapshot_id IS NOT NULL);

CREATE TABLE public.wb_category_current (
    subject_id bigint NOT NULL CHECK (subject_id > 0),
    language text NOT NULL CHECK (language IN ('ru', 'en', 'zh')),
    parent_id bigint NOT NULL CHECK (parent_id > 0),
    subject_name text NOT NULL,
    parent_name text NOT NULL,
    fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
    content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
    fetched_at_ms bigint NOT NULL CHECK (fetched_at_ms > 0),
    PRIMARY KEY (subject_id, language)
);

CREATE TABLE public.wb_category_field_defaults (
    subject_id bigint NOT NULL,
    language text NOT NULL,
    characteristics jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(characteristics) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    validated_catalog_digest text NOT NULL
        CHECK (validated_catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
    updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
    PRIMARY KEY (subject_id, language),
    FOREIGN KEY (subject_id, language)
        REFERENCES public.wb_category_current (subject_id, language)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.wb_category_current, public.wb_category_field_defaults TO podhub_app;
GRANT SELECT ON TABLE
    public.wb_category_current, public.wb_category_field_defaults TO podhub_worker;
-- Baseline default privileges grant worker DML; this family has one API writer.
REVOKE INSERT, UPDATE, DELETE ON TABLE
    public.wb_category_current, public.wb_category_field_defaults FROM podhub_worker;
GRANT UPDATE (fetched_at_ms) ON TABLE public.wb_category_current TO podhub_app;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
