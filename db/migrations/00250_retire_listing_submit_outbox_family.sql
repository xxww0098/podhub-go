-- +goose Up
-- declaration 250 RetireListingSubmitOutboxFamily m20260930_000433_retire_listing_submit_outbox_family
-- source: migration/src/retire_listing_submit_outbox_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.inbox_receipts, public.outbox_events;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
