-- +goose Up
-- +goose NO TRANSACTION
-- declaration 285 ListingRowModelIndex m20261014_000058_listing_row_model_index
-- source: migration/src/listing_row_model_index.rs @ a03d735
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."listing_rows_org_model_value_idx";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
