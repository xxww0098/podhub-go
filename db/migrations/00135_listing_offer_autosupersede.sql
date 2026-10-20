-- +goose Up
-- declaration 135 ListingOfferAutosupersede m20260911_000283_listing_offer_autosupersede
-- source: migration/src/listing_offer_autosupersede.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.guard_submission_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    now_ts timestamptz := clock_timestamp();
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

    -- Every fresh send leaves a new packet. Retire an unproven same-offer
    -- effect (or an unidentified one) as terminal history so it leaves the
    -- live offer set; the unknown fact is kept on the superseded row. A row a
    -- live reconciler has reserved is left to finish: its probe may still prove
    -- the Ozon effect, so that row fences the send until its claim expires.
    UPDATE public.submission_intents i
       SET state = 'superseded', updated_at = clock_timestamp()
     WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id AND i.id <> NEW.id
       AND i.state = 'unknown'
       AND (i.offer_id = NEW.offer_id OR i.offer_id IS NULL)
       AND (i.reconcile_claim_until IS NULL OR i.reconcile_claim_until <= now_ts);

    IF NULLIF(btrim(NEW.offer_id), '') IS NULL OR EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id AND i.id <> NEW.id
           AND (
             i.state IN ('queued', 'submitting', 'accepted')
             OR (i.state = 'unknown' AND i.reconcile_claim_until > now_ts)
           )
           AND (i.offer_id = NEW.offer_id OR i.offer_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'submission_intents_offer_busy: unresolved Store/offer effect'
            USING ERRCODE = '23505', CONSTRAINT = 'submission_intents_offer_busy';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
