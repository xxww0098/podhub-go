-- +goose Up
-- declaration 127 ListingReconciliation m20260906_000280_listing_reconciliation
-- source: migration/src/listing_reconciliation.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents ADD COLUMN offer_id text;
ALTER TABLE public.submission_intents ADD COLUMN reconcile_claim_until timestamptz;
ALTER TABLE public.submission_intents ADD COLUMN reconcile_epoch bigint NOT NULL DEFAULT 0;
CREATE INDEX submission_intents_reconcile_group_idx
    ON public.submission_intents (org_id, store_id, external_task_id)
    WHERE state IN ('unknown', 'accepted');

-- Only the committed send payload can identify a historical effect. Missing
-- evidence stays NULL; never infer it from a Row that may have since changed.
WITH frozen AS (
    SELECT j.org_id, j.aggregate_id::text AS intent_id, j.updated_at, j.input_revision::text AS row_revision,
           j.payload #>> '{import,items,0,offer_id}' AS offer_id
      FROM public.jobs j
     WHERE j.kind IN ('listing.submit', 'listing.reconcile')
       AND jsonb_array_length(CASE WHEN jsonb_typeof(j.payload #> '{import,items}') = 'array'
                             THEN j.payload #> '{import,items}' ELSE '[]'::jsonb END) = 1
    UNION ALL
    SELECT j.org_id, entry->>'intentId', j.updated_at, entry->>'rowRevision',
           entry #>> '{import,items,0,offer_id}'
      FROM public.jobs j
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(j.payload->'intents') = 'array'
               THEN j.payload->'intents' ELSE '[]'::jsonb END) entry
     WHERE j.kind = 'listing.submit.batch'
       AND jsonb_array_length(CASE WHEN jsonb_typeof(entry #> '{import,items}') = 'array'
                             THEN entry #> '{import,items}' ELSE '[]'::jsonb END) = 1
), identified AS (
    SELECT DISTINCT ON (f.org_id, f.intent_id) f.org_id, f.intent_id, NULLIF(btrim(f.offer_id), '') AS offer_id
      FROM frozen f JOIN public.submission_intents i
        ON i.org_id = f.org_id AND i.id::text = f.intent_id AND i.row_revision::text = f.row_revision
     ORDER BY f.org_id, f.intent_id, f.updated_at DESC
)
UPDATE public.submission_intents i SET offer_id = f.offer_id
  FROM identified f WHERE f.org_id = i.org_id AND f.intent_id = i.id::text;

CREATE INDEX submission_intents_active_offer_idx
    ON public.submission_intents (org_id, store_id, offer_id)
    WHERE state IN ('queued', 'submitting', 'unknown', 'accepted');

-- Historical colliding effects are evidence, so a unique index cannot replace
-- this guard. Serialize short Intent transactions per Store; no network call
-- holds this lock. Every insert, requeue and dispatch crosses the same guard.
CREATE FUNCTION public.guard_submission_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state NOT IN ('queued', 'submitting') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state
       AND NEW.offer_id IS NOT DISTINCT FROM OLD.offer_id THEN RETURN NEW; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('listing-store:' || NEW.store_id::text, 0));
    -- Let the existing idempotency constraints return their original Intent.
    IF TG_OP = 'INSERT' AND EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id
           AND ((i.listing_row_id = NEW.listing_row_id AND i.row_revision = NEW.row_revision)
                OR i.client_operation_id = NEW.client_operation_id)
    ) THEN RETURN NEW; END IF;

    IF NULLIF(btrim(NEW.offer_id), '') IS NULL OR EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id AND i.id <> NEW.id
           AND i.state IN ('queued', 'submitting', 'unknown', 'accepted')
           AND (i.offer_id = NEW.offer_id OR i.offer_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'submission_intents_offer_busy: unresolved Store/offer effect'
            USING ERRCODE = '23505', CONSTRAINT = 'submission_intents_offer_busy';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER submission_intents_offer_guard
    BEFORE INSERT OR UPDATE OF state, offer_id ON public.submission_intents
    FOR EACH ROW EXECUTE FUNCTION public.guard_submission_offer();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
