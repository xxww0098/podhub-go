-- +goose Up
-- declaration 252 RetireCardPackagesFamily m20260930_000435_retire_card_packages_family
-- source: migration/src/retire_card_packages_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.card_package_picks, public.card_packages;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
