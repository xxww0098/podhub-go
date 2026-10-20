-- +goose Up
-- declaration 82 CapacityReservationsRename m20260826_000244_capacity_reservations_rename
-- source: migration/src/capacity_reservations_rename.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.usage_reservations RENAME TO capacity_reservations;

ALTER INDEX IF EXISTS usage_reservations_org_state_idx
    RENAME TO capacity_reservations_org_state_idx;

ALTER TABLE public.capacity_reservations
    RENAME CONSTRAINT usage_reservations_job_unique TO capacity_reservations_job_unique;
ALTER TABLE public.capacity_reservations
    RENAME CONSTRAINT usage_reservations_estimated_nonneg TO capacity_reservations_estimated_nonneg;
ALTER TABLE public.capacity_reservations
    RENAME CONSTRAINT usage_reservations_state_known TO capacity_reservations_state_known;

COMMENT ON TABLE public.capacity_reservations IS
    'Pre-flight occupancy records for listed work; occupancy vocabulary only, money lives in the AI wallet.';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
