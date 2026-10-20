-- +goose Up
-- +goose NO TRANSACTION
-- declaration 107 ListingRowProjection m20260905_000268_listing_row_projection
-- source: migration/src/listing_row_projection.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE listing_rows ADD COLUMN IF NOT EXISTS view_revision bigint NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION bump_listing_view_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.view_revision := OLD.view_revision + 1;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_view_revision ON listing_rows;
CREATE TRIGGER listing_view_revision BEFORE UPDATE ON listing_rows
  FOR EACH ROW EXECUTE FUNCTION bump_listing_view_revision();
CREATE OR REPLACE FUNCTION touch_listing_intent_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE listing_rows SET updated_at = clock_timestamp()
    WHERE org_id = COALESCE(NEW.org_id, OLD.org_id)
      AND id = COALESCE(NEW.listing_row_id, OLD.listing_row_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS listing_intent_view_revision ON submission_intents;
CREATE TRIGGER listing_intent_view_revision AFTER INSERT OR UPDATE OR DELETE ON submission_intents
  FOR EACH ROW EXECUTE FUNCTION touch_listing_intent_row();
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "submission_intents_latest_row_idx" ON "public"."submission_intents" ("org_id", "listing_row_id", "row_revision" DESC, "created_at" DESC, "id" DESC);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
