-- +goose Up
-- declaration 190 ListingTasksReadyCheck m20260920_000328_listing_tasks_ready_check
-- source: migration/src/listing_tasks_ready_check.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_tasks
    DROP CONSTRAINT listing_tasks_ready_complete;
ALTER TABLE public.listing_tasks
    ADD CONSTRAINT listing_tasks_ready_complete
    CHECK (state <> 'ready' OR
           (store_id IS NOT NULL AND price_kopecks IS NOT NULL AND
            user_psd IS NOT NULL AND
            jsonb_array_length(product_images) > 0 AND
            (preparation->>'ai' = 'succeeded') IS TRUE AND
            (preparation->>'render' = 'succeeded') IS TRUE AND
            (preparation->>'upload' = 'succeeded') IS TRUE AND
            COALESCE(length(btrim(preparation->'content'->>'title')), 0) > 0 AND
            COALESCE(length(btrim(preparation->'content'->>'description')), 0) > 0 AND
            COALESCE(jsonb_array_length(preparation->'content'->'tags'), 0) > 0 AND
            COALESCE(length(btrim(preparation->'render_evidence'->>'manifest_digest')), 0) > 0 AND
            COALESCE(jsonb_array_length(preparation->'render_evidence'->'images'), 0) > 0 AND
            COALESCE(jsonb_array_length(preparation->'delivered_images'), 0) =
                COALESCE(jsonb_array_length(preparation->'render_evidence'->'images'), 0)));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
