-- +goose Up
-- declaration 175 ListingDispatchRecovery m20260916_000314_listing_dispatch_recovery
-- source: migration/src/listing_dispatch_recovery.rs @ a03d735
-- +goose StatementBegin
CREATE FUNCTION public.lock_listing_dispatch_recovery_workspace()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    workspace_id bigint;
    dissolved boolean;
BEGIN
    workspace_id := NULLIF(current_setting('app.current_org_id', true), '')::bigint;
    IF workspace_id IS NULL THEN
        RAISE EXCEPTION 'listing recovery requires a tenant binding'
            USING ERRCODE = '22023';
    END IF;
    SELECT o.dissolved_at IS NOT NULL
      INTO dissolved
      FROM public.organizations AS o
     WHERE o.id = workspace_id
     FOR NO KEY UPDATE;
    IF NOT FOUND OR dissolved THEN
        RAISE EXCEPTION 'listing recovery workspace is not live'
            USING ERRCODE = '22023';
    END IF;
END
$$;

REVOKE ALL ON FUNCTION public.lock_listing_dispatch_recovery_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_listing_dispatch_recovery_workspace() TO podhub_app;

ALTER TABLE public.listing_dispatch_batches
    ADD COLUMN recovery_of_batch_id uuid,
    ADD COLUMN seller_client_id text,
    ADD COLUMN reconcile_epoch bigint NOT NULL DEFAULT 0,
    ADD COLUMN reconcile_claim_until_ms bigint,
    DROP CONSTRAINT listing_dispatch_batches_state_known,
    ADD CONSTRAINT listing_dispatch_batches_state_known
        CHECK (state IN ('queued', 'dispatching', 'unknown', 'accepted', 'rejected', 'superseded')),
    DROP CONSTRAINT listing_dispatch_batches_body_lifecycle,
    ADD CONSTRAINT listing_dispatch_batches_body_lifecycle
        CHECK ((state IN ('dispatching', 'unknown', 'superseded')) = (request_body IS NOT NULL)),
    DROP CONSTRAINT listing_dispatch_batches_dispatch_identity,
    ADD CONSTRAINT listing_dispatch_batches_dispatch_identity
        CHECK (state = 'queued' OR request_hash IS NOT NULL OR
               (state = 'rejected' AND request_hash IS NULL)),
    DROP CONSTRAINT listing_dispatch_batches_effect_started,
    ADD CONSTRAINT listing_dispatch_batches_effect_started
        CHECK (effect_started_at_ms IS NULL OR state IN ('dispatching', 'unknown', 'superseded')),
    ADD CONSTRAINT listing_dispatch_batches_recovery_fk
        FOREIGN KEY (recovery_of_batch_id, org_id)
        REFERENCES public.listing_dispatch_batches (id, org_id),
    ADD CONSTRAINT listing_dispatch_batches_recovery_unique
        UNIQUE (org_id, recovery_of_batch_id),
    ADD CONSTRAINT listing_dispatch_batches_recovery_not_self
        CHECK (recovery_of_batch_id IS NULL OR recovery_of_batch_id <> id),
    ADD CONSTRAINT listing_dispatch_batches_reconcile_epoch_nonnegative
        CHECK (reconcile_epoch >= 0),
    ADD CONSTRAINT listing_dispatch_batches_reconcile_claim_positive
        CHECK (reconcile_claim_until_ms IS NULL OR reconcile_claim_until_ms > 0);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
