-- +goose Up
-- +goose NO TRANSACTION
-- declaration 8 RepairOfficialPackagesAndSupportGrants m20260802_000032_repair_official_packages_and_support_grants
-- source: migration/src/uniqueness.rs @ a03d735
-- +goose StatementBegin
UPDATE public.listing_field_templates AS surplus
SET scope = 'org',
    updated_at_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
WHERE surplus.scope = 'official'
  AND surplus.id <> (
      SELECT MIN(keep.id)
      FROM public.listing_field_templates AS keep
      WHERE keep.scope = 'official'
        AND keep.category_id = surplus.category_id
  );
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.support_grants
SET revoked_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE revoked_at IS NULL
  AND expires_at <= clock_timestamp();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
