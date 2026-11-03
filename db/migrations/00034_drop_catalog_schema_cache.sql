-- +goose Up
-- The gzip schema cache duplicated ozon_category_current. Reads now use the
-- current row and listing_schema_revisions, so the legacy table has no reader
-- or writer and does not stay in the schema.
DROP TABLE public.ozon_catalog_schema_cache;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
  RAISE EXCEPTION 'Dropping the category schema cache is irreversible; restore the pre-migration backup to roll back';
END $$;
-- +goose StatementEnd
