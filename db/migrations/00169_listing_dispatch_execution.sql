-- +goose Up
-- declaration 169 ListingDispatchExecution m20260914_000312_listing_dispatch_execution
-- source: migration/src/listing_dispatch_execution.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_dispatch_batches
    ADD COLUMN request_body text,
    ADD COLUMN request_hash character varying(71),
    ADD COLUMN external_task_id text,
    ADD COLUMN receipt jsonb,
    ADD COLUMN reconciliation jsonb,
    ADD COLUMN last_error_code character varying(96),
    ADD COLUMN effect_started_at_ms bigint,
    ADD COLUMN reconcile_after_ms bigint,
    ADD CONSTRAINT listing_dispatch_batches_hash_shape
        CHECK (request_hash IS NULL OR request_hash ~ '^sha256:[0-9a-f]{64}$'),
    ADD CONSTRAINT listing_dispatch_batches_body_lifecycle
        CHECK ((state IN ('dispatching', 'unknown')) = (request_body IS NOT NULL)),
    ADD CONSTRAINT listing_dispatch_batches_dispatch_identity
        CHECK (state = 'queued' OR request_hash IS NOT NULL OR
               (state = 'rejected' AND request_hash IS NULL)),
    ADD CONSTRAINT listing_dispatch_batches_effect_started
        CHECK (effect_started_at_ms IS NULL OR state IN ('dispatching', 'unknown'));

ALTER TABLE public.listing_dispatch_items
    ADD COLUMN offer_id text,
    ADD COLUMN release_reason jsonb,
    ADD CONSTRAINT listing_dispatch_items_offer_not_blank
        CHECK (offer_id IS NULL OR length(btrim(offer_id)) > 0),
    ADD CONSTRAINT listing_dispatch_items_release_pair
        CHECK ((released_at_ms IS NULL) = (release_reason IS NULL));

CREATE INDEX listing_dispatch_batches_unknown_due_idx
    ON public.listing_dispatch_batches (reconcile_after_ms, created_at_ms, id)
    WHERE state = 'unknown';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.listing_dispatch_batches, public.listing_dispatch_items
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
