-- +goose Up
-- declaration 133 ListingQueuePositionIndex m20260910_000265_listing_queue_position_index
-- source: migration/src/listing_queue_position_index.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_rows
    ADD COLUMN queue_position bigint GENERATED ALWAYS AS (
COALESCE(
    CASE
        WHEN jsonb_typeof(payload->'queuePosition') = 'number'
            AND (payload->>'queuePosition') ~ '^-?[0-9]{1,19}$'
            AND (
                (payload->>'queuePosition') !~ '^-?[0-9]{19}$'
                OR (payload->>'queuePosition') ~ '^-?[0-8][0-9]{18}$'
            )
        THEN (payload->>'queuePosition')::bigint
    END,
    9223372036854775807
)
    ) STORED;

CREATE INDEX listing_rows_org_card_queue_idx
    ON public.listing_rows (org_id, card_id, queue_position, created_at, id);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
