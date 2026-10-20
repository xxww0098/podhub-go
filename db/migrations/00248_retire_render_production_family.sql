-- +goose Up
-- declaration 248 RetireRenderProductionFamily m20260930_000431_retire_render_production_family
-- source: migration/src/retire_render_production_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.relay_logs, public.render_campaigns, public.render_jobs, public.production_operations, public.publish_profiles;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
