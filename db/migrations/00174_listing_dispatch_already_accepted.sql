-- +goose Up
-- declaration 174 ListingDispatchAlreadyAccepted m20260916_000313_listing_dispatch_already_accepted
-- source: migration/src/listing_dispatch_already_accepted.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_dispatch_rejections
    DROP CONSTRAINT listing_dispatch_rejections_reason_known,
    ADD CONSTRAINT listing_dispatch_rejections_reason_known
        CHECK (reason IN (
            'task_not_found', 'task_not_ready', 'store_unavailable',
            'store_not_ready', 'supplier_config_invalid', 'revision_changed',
            'active_batch', 'already_accepted'
        ));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
