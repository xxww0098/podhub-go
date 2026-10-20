-- +goose Up
-- declaration 220 ListingRowsBuildStateValidate m20260923_000402_listing_rows_build_state_validate
-- source: migration/src/listing_rows_build_state_validate.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_rows VALIDATE CONSTRAINT listing_rows_build_state_known;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
