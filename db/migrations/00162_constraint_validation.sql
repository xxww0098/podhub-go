-- +goose Up
-- declaration 162 ConstraintValidation m20260914_000306_constraint_validation
-- source: migration/src/constraint_validation.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organizations VALIDATE CONSTRAINT ck_organizations_store_limit_override;
ALTER TABLE public.ai_requests VALIDATE CONSTRAINT ai_requests_channel_name_valid;
ALTER TABLE public.sc_products VALIDATE CONSTRAINT ck_sc_products_gross_weight;
ALTER TABLE public.sc_source_offers VALIDATE CONSTRAINT ck_sc_source_offers_cost;
ALTER TABLE public.sc_source_offers VALIDATE CONSTRAINT ck_sc_source_offers_shipping;
ALTER TABLE public.sc_source_offers VALIDATE CONSTRAINT ck_sc_source_offers_nonempty;
ALTER TABLE public.ai_requests VALIDATE CONSTRAINT ai_requests_hold_nonneg;
ALTER TABLE public.listing_rows VALIDATE CONSTRAINT listing_rows_submission_state_known;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
