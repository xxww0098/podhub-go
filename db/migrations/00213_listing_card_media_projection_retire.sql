-- +goose Up
-- declaration 213 ListingCardMediaProjectionRetire m20260923_000100_listing_card_media_projection_retire
-- source: migration/src/listing_card_media_projection_retire.rs @ a03d735
-- +goose StatementBegin
DROP TRIGGER IF EXISTS listing_card_media_projection ON listing_cards;
DROP FUNCTION IF EXISTS touch_listing_card_media_rows();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
