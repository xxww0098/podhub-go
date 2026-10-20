-- +goose Up
-- declaration 106 ListingSubmitOutboxDrain m20260905_000267_listing_submit_outbox_drain
-- source: migration/src/listing_submit_outbox_drain.rs @ a03d735
-- +goose StatementBegin
DO $drain$
DECLARE
    event record;
    intent record;
    existing_job record;
    item jsonb;
    items jsonb;
    job_kind text;
    aggregate_kind text;
    aggregate_uuid uuid;
    operation_id text;
    store_uuid uuid;
    item_intent_uuid uuid;
    item_row_uuid uuid;
    item_revision bigint;
    input_revision bigint;
BEGIN
    LOCK TABLE public.outbox_events, public.inbox_receipts IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (
        SELECT 1 FROM public.inbox_receipts r
        WHERE r.consumer = 'outbox-dispatcher'
          AND NOT EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.id = r.event_id)
    ) THEN
        RAISE EXCEPTION 'Listing outbox drain: inbox receipt has no event';
    END IF;

    FOR event IN SELECT * FROM public.outbox_events
                 WHERE published_at IS NULL ORDER BY created_at, id FOR UPDATE
    LOOP
        IF event.topic NOT IN ('listing.intent.queued', 'listing.batch.queued') THEN
            RAISE EXCEPTION 'Listing outbox drain: unknown topic % on event %', event.topic, event.id;
        END IF;
        IF jsonb_typeof(event.payload) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Listing outbox drain: invalid payload on event %', event.id;
        END IF;
        IF COALESCE(event.payload->'storeId', event.payload->'store_id') IS NOT NULL
           AND jsonb_typeof(COALESCE(event.payload->'storeId', event.payload->'store_id')) <> 'string' THEN
            RAISE EXCEPTION 'Listing outbox drain: invalid Store type on event %', event.id;
        END IF;
        store_uuid := COALESCE(event.payload->>'storeId', event.payload->>'store_id')::uuid;
        IF event.topic = 'listing.intent.queued' THEN
            IF jsonb_typeof(COALESCE(event.payload->'intentId', event.payload->'intent_id')) IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION 'Listing outbox drain: invalid intent identity type on event %', event.id;
            END IF;
            job_kind := 'listing.submit';
            aggregate_kind := 'submission_intent';
            operation_id := COALESCE(event.payload->>'intentId', event.payload->>'intent_id');
            items := jsonb_build_array(event.payload);
        ELSE
            IF jsonb_typeof(COALESCE(event.payload->'batchId', event.payload->'batch_id')) IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION 'Listing outbox drain: invalid batch identity type on event %', event.id;
            END IF;
            job_kind := 'listing.submit.batch';
            aggregate_kind := 'submission_batch';
            operation_id := COALESCE(event.payload->>'batchId', event.payload->>'batch_id');
            items := event.payload->'intents';
            IF store_uuid IS NULL THEN
                RAISE EXCEPTION 'Listing outbox drain: missing Store on event %', event.id;
            END IF;
        END IF;
        aggregate_uuid := operation_id::uuid;
        IF aggregate_uuid IS NULL OR jsonb_typeof(items) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'Listing outbox drain: invalid identity or intents on event %', event.id;
        END IF;
        IF jsonb_array_length(items) = 0 THEN
            RAISE EXCEPTION 'Listing outbox drain: empty intents on event %', event.id;
        END IF;
        input_revision := NULL;
        FOR item IN SELECT value FROM jsonb_array_elements(items)
        LOOP
            IF jsonb_typeof(item) IS DISTINCT FROM 'object'
               OR jsonb_typeof(COALESCE(item->'intentId', item->'intent_id')) IS DISTINCT FROM 'string'
               OR (COALESCE(item->'rowId', item->'row_id') IS NOT NULL
                   AND jsonb_typeof(COALESCE(item->'rowId', item->'row_id')) <> 'string')
               OR (COALESCE(item->'rowRevision', item->'row_revision') IS NOT NULL
                   AND jsonb_typeof(COALESCE(item->'rowRevision', item->'row_revision')) <> 'number') THEN
                RAISE EXCEPTION 'Listing outbox drain: invalid intent field type on event %', event.id;
            END IF;
            item_intent_uuid := COALESCE(item->>'intentId', item->>'intent_id')::uuid;
            item_row_uuid := COALESCE(item->>'rowId', item->>'row_id')::uuid;
            item_revision := COALESCE(item->>'rowRevision', item->>'row_revision', '1')::bigint;
            IF item_intent_uuid IS NULL OR item_revision < 1
               OR (job_kind = 'listing.submit.batch' AND item_row_uuid IS NULL)
               OR jsonb_typeof(item->'import'->'items') IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'Listing outbox drain: invalid intent payload on event %', event.id;
            END IF;
            IF jsonb_array_length(item->'import'->'items') <> 1
               OR jsonb_typeof(item->'import'->'items'->0) IS DISTINCT FROM 'object'
               OR jsonb_typeof(item->'import'->'items'->0->'offer_id') IS DISTINCT FROM 'string'
               OR jsonb_typeof(item->'import'->'items'->0->'name') IS DISTINCT FROM 'string'
               OR COALESCE(btrim(item->'import'->'items'->0->>'offer_id'), '') = ''
               OR COALESCE(btrim(item->'import'->'items'->0->>'name'), '') = '' THEN
                RAISE EXCEPTION 'Listing outbox drain: invalid frozen import on event %', event.id;
            END IF;
            SELECT * INTO intent FROM public.submission_intents WHERE id = item_intent_uuid;
            IF NOT FOUND OR intent.org_id <> event.org_id
               OR (store_uuid IS NOT NULL AND intent.store_id <> store_uuid)
               OR (item_row_uuid IS NOT NULL AND intent.listing_row_id <> item_row_uuid)
               OR intent.row_revision <> item_revision THEN
                RAISE EXCEPTION 'Listing outbox drain: intent does not match event %', event.id;
            END IF;
            input_revision := COALESCE(input_revision, item_revision);
        END LOOP;

        SELECT * INTO existing_job FROM public.jobs
        WHERE org_id = event.org_id AND kind = job_kind
          AND idempotency_key = operation_id;
        IF FOUND THEN
            IF existing_job.aggregate_type <> aggregate_kind
               OR existing_job.aggregate_id <> aggregate_uuid
               OR existing_job.input_revision <> input_revision
               OR existing_job.payload IS DISTINCT FROM event.payload THEN
                RAISE EXCEPTION 'Listing outbox drain: conflicting Job on event %', event.id;
            END IF;
        ELSE
            IF EXISTS (SELECT 1 FROM public.inbox_receipts
                       WHERE consumer = 'outbox-dispatcher' AND event_id = event.id) THEN
                RAISE EXCEPTION 'Listing outbox drain: inbox receipt has no matching Job for event %', event.id;
            END IF;
            INSERT INTO public.jobs (
                id, org_id, kind, aggregate_type, aggregate_id, input_revision,
                idempotency_key, priority, state, payload, max_attempts, cost_units, lane
            ) VALUES (
                event.id, event.org_id, job_kind, aggregate_kind, aggregate_uuid, input_revision,
                operation_id, 50, 'queued', event.payload, 8, 4, job_kind
            );
        END IF;
        INSERT INTO public.inbox_receipts (consumer, event_id)
        VALUES ('outbox-dispatcher', event.id) ON CONFLICT (consumer, event_id) DO NOTHING;
        UPDATE public.outbox_events SET published_at = clock_timestamp() WHERE id = event.id;
    END LOOP;
END
$drain$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
