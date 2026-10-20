-- +goose Up
-- declaration 180 ShippingRuntimeGrants m20260917_000318_shipping_runtime_grants
-- source: migration/src/shipping_runtime_grants.rs @ a03d735
-- +goose StatementBegin
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.sc_listing_bindings,
    public.shipping_presets,
    public.shipping_preset_versions,
    public.shipping_sku_bindings,
    public.shipping_shop_injections,
    public.shipping_inject_operations
    TO podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE
    public.sc_listing_bindings_id_seq,
    public.shipping_presets_id_seq,
    public.shipping_preset_versions_id_seq,
    public.shipping_sku_bindings_id_seq,
    public.shipping_shop_injections_id_seq,
    public.shipping_inject_operations_id_seq
    TO podhub_app, podhub_worker;
-- SELECT ... FOR SHARE needs some UPDATE privilege: the store-pause fence in
-- submission_issues locks organization_stores while recording scoped issues.
GRANT UPDATE (updated_at) ON TABLE public.organization_stores
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
