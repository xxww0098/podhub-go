-- +goose Up
ALTER TABLE public.workspace_slice_provisions ADD COLUMN custom_name boolean NOT NULL DEFAULT false;
ALTER TABLE public.workspace_slice_provisions DROP CONSTRAINT workspace_slice_provisions_bucket_key;
ALTER TABLE public.workspace_slice_provisions ADD CONSTRAINT workspace_slice_provisions_account_bucket_key UNIQUE (account_id,bucket);
GRANT DELETE ON public.workspace_slice_provisions TO podhub_app;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'Custom bucket provenance and account-scoped names require a reviewed rollback';
END $$;
-- +goose StatementEnd
