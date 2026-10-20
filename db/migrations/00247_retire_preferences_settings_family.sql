-- +goose Up
-- declaration 247 RetirePreferencesSettingsFamily m20260930_000430_retire_preferences_settings_family
-- source: migration/src/retire_preferences_settings_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.app_settings, public.org_notifications, public.template_packs, public.user_preferences;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
