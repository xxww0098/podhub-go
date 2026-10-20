-- +goose Up
-- declaration 219 ListingRowsBuildEvidence m20260923_000401_listing_rows_build_evidence
-- source: migration/src/listing_rows_build_evidence.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_rows
    ADD COLUMN build_state text NOT NULL DEFAULT 'stale',
    ADD COLUMN build_digest text,
    ADD COLUMN build_card_digest text,
    ADD COLUMN build_sources jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.listing_rows
    ADD CONSTRAINT listing_rows_build_state_known
    CHECK (build_state IN ('stale', 'built')) NOT VALID;

ALTER TABLE public.listing_rows
    DROP COLUMN field_sources;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
