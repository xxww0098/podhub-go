-- +goose Up
-- declaration 242 RetireClientReleasesFamily m20260930_000425_retire_client_releases_family
-- source: migration/src/retire_client_releases_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.client_releases;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
