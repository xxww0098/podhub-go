-- +goose Up
-- declaration 286 ProductGroupingTerminalPartial m20261014_000059_product_grouping_terminal_partial
-- source: migration/src/product_grouping_terminal_partial.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.seller_upstream_writes
    DROP CONSTRAINT seller_upstream_writes_observation_due;
ALTER TABLE public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_observation_due CHECK (
        observation_state IS NULL
        OR (observation_state = 'pending' AND observation_next_at IS NOT NULL)
        OR observation_state = 'partial'
        OR (observation_state IN ('applied', 'rejected', 'needs_review')
            AND observation_next_at IS NULL));

WITH settled AS (
UPDATE public.seller_upstream_writes
SET observation_next_at = NULL,
    state = CASE WHEN state = 'result_unknown' THEN 'reconciled' ELSE state END,
    reconcile_after = NULL,
    observation_lease_token = NULL,
    observation_lease_until = NULL,
    observation_lease_epoch = observation_lease_epoch + 1,
    updated_at = clock_timestamp()
WHERE kind = 'product_grouping'
  AND observation_state = 'partial'
  AND CASE WHEN jsonb_typeof(observation_items) = 'array' THEN
      jsonb_array_length(observation_items) > 0
      AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(observation_items) item
          -- Freeze the operation-item wire shape here: the migration cannot
          -- depend on the runtime DTO, and corrupt optional fields/unknown
          -- keys must not release resources that runtime cannot deserialize.
          WHERE CASE WHEN jsonb_typeof(item) <> 'object' THEN true ELSE
              COALESCE(item->>'state', '') NOT IN ('applied', 'rejected')
              OR jsonb_typeof(item->'productId') IS DISTINCT FROM 'string'
              OR jsonb_typeof(item->'offerId') IS DISTINCT FROM 'string'
              OR COALESCE(item->>'productId', '') = ''
              OR COALESCE(item->>'offerId', '') = ''
              OR item - ARRAY['productId', 'offerId', 'state', 'taskId', 'detailCode']
                    <> '{}'::jsonb
              OR CASE
                  WHEN NOT (item ? 'taskId') OR item->'taskId' = 'null'::jsonb THEN false
                  WHEN jsonb_typeof(item->'taskId') = 'number'
                       AND item->>'taskId' ~ '^-?(0|[1-9][0-9]*)$'
                  THEN (item->>'taskId')::numeric NOT BETWEEN
                       -9223372036854775808 AND 9223372036854775807
                  ELSE true END
              OR CASE
                  WHEN NOT (item ? 'detailCode') OR item->'detailCode' = 'null'::jsonb
                  THEN false
                  ELSE jsonb_typeof(item->'detailCode') IS DISTINCT FROM 'string' END
              END
      )
      ELSE false END
RETURNING id, org_id, store_id
)
UPDATE public.seller_resource_occupancies occupancy
SET state = 'released',
    released_at_ms = (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    release_reason = 'partial_settled'
FROM settled
WHERE occupancy.org_id = settled.org_id
  AND occupancy.store_pk = settled.store_id
  AND occupancy.owner_kind = 'store_write'
  AND occupancy.owner_ref = settled.id::text
  AND occupancy.state = 'held';

-- Refreshing the same digest must extend its TTL under runtime roles too.
GRANT UPDATE ON public.product_variant_previews TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
