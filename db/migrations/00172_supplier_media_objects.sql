-- +goose Up
-- declaration 172 SupplierMediaObjects m20260915_000003_supplier_media_objects
-- source: migration/src/supplier_media_objects.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.supplier_media_objects (
    product_id text NOT NULL
        REFERENCES public.sc_products (product_id) ON DELETE CASCADE,
    source_id text NOT NULL
        REFERENCES public.sc_sources (source_id) ON DELETE CASCADE,
    object_key text NOT NULL,
    public_url text NOT NULL,
    media_kind character varying(16) NOT NULL,
    extension character varying(8) NOT NULL,
    content_sha256 character varying(64) NOT NULL,
    byte_length bigint NOT NULL,
    integration_revision bigint NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (product_id, object_key),
    CONSTRAINT supplier_media_objects_url_unique UNIQUE (product_id, public_url),
    CONSTRAINT supplier_media_objects_kind_known
        CHECK (media_kind IN ('gallery', 'psd', 'video')),
    CONSTRAINT supplier_media_objects_extension_known
        CHECK (extension IN ('jpg', 'png', 'webp', 'psd', 'mp4', 'mov')),
    CONSTRAINT supplier_media_objects_digest_shape
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT supplier_media_objects_byte_length_positive CHECK (byte_length > 0),
    CONSTRAINT supplier_media_objects_integration_revision_positive
        CHECK (integration_revision > 0)
);

CREATE INDEX supplier_media_objects_digest_idx
    ON public.supplier_media_objects (product_id, content_sha256);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
