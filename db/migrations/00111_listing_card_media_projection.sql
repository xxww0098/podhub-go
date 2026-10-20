-- +goose Up
-- declaration 111 ListingCardMediaProjection m20260905_000272_listing_card_media_projection
-- source: migration/src/listing_card_media_projection.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION touch_listing_card_media_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Batch send locks the same rows in ID order before reading Card facts.
  PERFORM id FROM listing_rows WHERE org_id = NEW.org_id AND card_id = NEW.id
    ORDER BY id FOR UPDATE;
  UPDATE listing_rows SET updated_at = clock_timestamp()
    WHERE org_id = NEW.org_id AND card_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER listing_card_media_projection AFTER UPDATE OF payload ON listing_cards
 FOR EACH ROW WHEN (OLD.payload->>'psdTemplateSha256' IS DISTINCT FROM NEW.payload->>'psdTemplateSha256')
 EXECUTE FUNCTION touch_listing_card_media_rows();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
