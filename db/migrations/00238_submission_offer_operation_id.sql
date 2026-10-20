-- +goose Up
-- declaration 238 SubmissionOfferOperationId m20260930_000420_submission_offer_operation_id
-- source: migration/src/submission_offer_operation_id.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    DROP CONSTRAINT IF EXISTS submission_intents_row_revision;

CREATE OR REPLACE FUNCTION public.guard_submission_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state NOT IN ('queued', 'submitting') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state
       AND NEW.offer_id IS NOT DISTINCT FROM OLD.offer_id THEN RETURN NEW; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('listing-store:' || NEW.store_id::text, 0));
    -- Let the existing idempotency constraint return its original Intent.
    -- `client_operation_id` is the only surviving identity now that
    -- `submission_intents_row_revision` is gone.
    IF TG_OP = 'INSERT' AND EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id
           AND i.client_operation_id = NEW.client_operation_id
    ) THEN RETURN NEW; END IF;

    UPDATE public.submission_intents i
       SET state = 'superseded', updated_at = clock_timestamp()
     WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id AND i.id <> NEW.id
       AND i.state = 'unknown'
       AND (i.offer_id = NEW.offer_id OR i.offer_id IS NULL);

    IF NULLIF(btrim(NEW.offer_id), '') IS NULL OR EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id AND i.id <> NEW.id
           AND i.state IN ('queued', 'submitting', 'accepted')
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
