-- +goose Up
-- +goose NO TRANSACTION
-- declaration 9 ListingFieldTemplatesOfficialCategoryUidx m20260802_000033_listing_field_templates_official_category_uidx
-- source: migration/src/uniqueness.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "listing_field_templates_official_category_uidx" ON "public"."listing_field_templates" ("category_id") WHERE scope = 'official';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
