-- +goose Up
-- declaration 167 ListingTaskPreparation m20260914_000310_listing_task_preparation
-- source: migration/src/listing_task_preparation.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_tasks
    DROP CONSTRAINT listing_tasks_ready_complete;
ALTER TABLE public.listing_tasks
    ADD CONSTRAINT listing_tasks_ready_complete
    CHECK (state <> 'ready' OR
           (store_id IS NOT NULL AND price_kopecks IS NOT NULL AND
            user_psd IS NOT NULL AND
            jsonb_array_length(product_images) > 0 AND
            preparation->>'ai' = 'succeeded' AND
            preparation->>'render' = 'succeeded' AND
            preparation->>'upload' = 'succeeded' AND
            COALESCE(length(btrim(preparation->'content'->>'title')), 0) > 0 AND
            COALESCE(length(btrim(preparation->'content'->>'description')), 0) > 0 AND
            COALESCE(jsonb_array_length(preparation->'content'->'tags'), 0) > 0 AND
            COALESCE(length(btrim(preparation->'render_evidence'->>'manifest_digest')), 0) > 0 AND
            COALESCE(jsonb_array_length(preparation->'render_evidence'->'images'), 0) > 0 AND
            COALESCE(jsonb_array_length(preparation->'delivered_images'), 0) =
                COALESCE(jsonb_array_length(preparation->'render_evidence'->'images'), 0)));

-- Settlement reconstructs content from this paid-response authority. The
-- application role receives business-column read access; every repository
-- lookup remains Workspace-predicated and no public request can write it.
GRANT SELECT ON TABLE public.ai_requests, public.media_object_leases
    TO podhub_app, podhub_worker;
-- `admit_verified_lease` uses `FOR SHARE`; PostgreSQL requires some UPDATE
-- privilege for that lock even though the verifier does not mutate the row.
GRANT UPDATE (updated_at) ON TABLE public.media_object_leases
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
