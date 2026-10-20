-- +goose Up
-- declaration 253 RetireDesktopTelemetry m20260930_000436_retire_desktop_telemetry
-- source: migration/src/retire_desktop_telemetry.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.diagnostic_bundles, public.plugin_usage_events, public.plugin_usage_rollups, public.track_events;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
