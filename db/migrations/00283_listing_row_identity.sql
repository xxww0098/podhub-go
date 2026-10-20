-- +goose Up
-- +goose NO TRANSACTION
-- declaration 283 ListingRowIdentity m20261014_000056_listing_row_identity
-- source: migration/src/listing_row_identity.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_rows
    ADD COLUMN IF NOT EXISTS create_key text,
    ADD COLUMN IF NOT EXISTS create_fingerprint text,
    ADD COLUMN IF NOT EXISTS association_id uuid,
    ADD COLUMN IF NOT EXISTS model_value text NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "listing_rows_model_value_hash_idx" ON "public"."listing_rows" USING hash ("model_value") WHERE model_value <> '';
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."listing_rows_org_model_value_idx";
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "listing_rows_one_create_key_per_card" ON "public"."listing_rows" ("org_id", "card_id", "create_key") WHERE create_key IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "listing_rows_org_association_idx" ON "public"."listing_rows" ("org_id", "association_id") WHERE association_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
