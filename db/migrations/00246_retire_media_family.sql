-- +goose Up
-- declaration 246 RetireMediaFamily m20260930_000429_retire_media_family
-- source: migration/src/retire_media_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.media_assets, public.media_storage_backends, public.media_upload_sessions;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
