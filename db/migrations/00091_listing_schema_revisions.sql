-- +goose Up
-- +goose NO TRANSACTION
-- declaration 91 ListingSchemaRevisions m20260901_000250_listing_schema_revisions
-- source: migration/src/listing_schema_revisions.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.listing_schema_revisions (
    schema_revision text PRIMARY KEY,
    snapshot        jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT listing_schema_revisions_revision_nonempty CHECK (
        char_length(schema_revision) BETWEEN 1 AND 256
    )
);

ALTER TABLE public.listing_rows
    ADD COLUMN category_key text GENERATED ALWAYS AS (payload->>'categoryKey') STORED;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "listing_rows_org_category_updated_idx" ON "public"."listing_rows" ("org_id", "category_key", "updated_at" DESC);
-- +goose StatementEnd
-- +goose StatementBegin
GRANT SELECT, INSERT ON TABLE public.listing_schema_revisions TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
