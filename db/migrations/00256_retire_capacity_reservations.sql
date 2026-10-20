-- +goose Up
-- declaration 256 RetireCapacityReservations m20260930_000439_retire_capacity_reservations
-- source: migration/src/retire_capacity_reservations.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.capacity_reservations;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
