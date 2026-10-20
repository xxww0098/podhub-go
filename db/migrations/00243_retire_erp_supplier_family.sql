-- +goose Up
-- declaration 243 RetireErpSupplierFamily m20260930_000426_retire_erp_supplier_family
-- source: migration/src/retire_erp_supplier_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.erp_orders, public.erp_supplier_notifications, public.erp_supplier_offer_bindings, public.erp_supplier_users, public.erp_suppliers;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
