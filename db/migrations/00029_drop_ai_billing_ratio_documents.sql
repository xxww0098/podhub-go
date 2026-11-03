-- +goose Up
-- Pricing reads admin-managed schedules in ai_prices. The legacy ratio mirror
-- is no longer written or read, so it does not stay in the schema.
DROP TABLE public.ai_billing_ratio_documents;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
  RAISE EXCEPTION 'Dropping the ratio mirror is irreversible; restore the pre-migration backup to roll back';
END $$;
-- +goose StatementEnd
