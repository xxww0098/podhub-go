-- +goose Up
-- User PSD bytes stay on the device. Existing cloud objects are not deleted here.
DELETE FROM public.storage_object_refs WHERE owner_kind = 'psd_template';
DELETE FROM public.storage_uploads WHERE purpose_kind = 'org_template';
DROP TABLE public.workspace_psd_templates;
ALTER TABLE public.organizations DROP COLUMN psd_upload_enabled;
ALTER TABLE public.storage_object_refs DROP CONSTRAINT storage_object_refs_owner_kind_check;
ALTER TABLE public.storage_object_refs ADD CONSTRAINT storage_object_refs_owner_kind_check
  CHECK (owner_kind IN ('delegate_asset', 'dispatch', 'source_product', 'catalog_product', 'catalog_sku', 'ai_image_set', 'ai_image_item'));
ALTER TABLE public.storage_uploads DROP CONSTRAINT storage_uploads_purpose_kind_check;
ALTER TABLE public.storage_uploads ADD CONSTRAINT storage_uploads_purpose_kind_check
  CHECK (purpose_kind IN ('org_file', 'delegate_binding', 'source', 'catalog', 'listing_image'));

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
  RAISE EXCEPTION 'User PSD backup removal is irreversible; restore the pre-migration backup to roll back';
END $$;
-- +goose StatementEnd
