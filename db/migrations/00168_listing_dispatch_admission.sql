-- +goose Up
-- declaration 168 ListingDispatchAdmission m20260914_000311_listing_dispatch_admission
-- source: migration/src/listing_dispatch_admission.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.listing_dispatch_admissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    admitted_by_user_id bigint NOT NULL REFERENCES public.account_users(id),
    idempotency_key character varying(200) NOT NULL,
    input_digest character varying(71) NOT NULL,
    requested_task_count smallint NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT listing_dispatch_admissions_key_not_blank
        CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT listing_dispatch_admissions_digest_shape
        CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT listing_dispatch_admissions_request_bound
        CHECK (requested_task_count BETWEEN 1 AND 500),
    CONSTRAINT listing_dispatch_admissions_key_unique
        UNIQUE (org_id, idempotency_key),
    CONSTRAINT listing_dispatch_admissions_identity_unique
        UNIQUE (id, org_id)
);

CREATE TABLE public.listing_dispatch_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admission_id uuid NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL REFERENCES public.organization_stores(uuid),
    batch_index smallint NOT NULL,
    state character varying(16) NOT NULL DEFAULT 'queued',
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT listing_dispatch_batches_admission_fk
        FOREIGN KEY (admission_id, org_id)
        REFERENCES public.listing_dispatch_admissions(id, org_id),
    CONSTRAINT listing_dispatch_batches_index_bound
        CHECK (batch_index BETWEEN 0 AND 499),
    CONSTRAINT listing_dispatch_batches_state_known
        CHECK (state IN ('queued', 'dispatching', 'unknown', 'accepted', 'rejected')),
    CONSTRAINT listing_dispatch_batches_slot_unique
        UNIQUE (admission_id, batch_index),
    CONSTRAINT listing_dispatch_batches_identity_unique
        UNIQUE (id, org_id)
);

CREATE TABLE public.listing_dispatch_items (
    batch_id uuid NOT NULL,
    org_id bigint NOT NULL,
    task_id uuid NOT NULL,
    task_revision bigint NOT NULL,
    supplier_product_id text NOT NULL,
    batch_item_index smallint NOT NULL,
    released_at_ms bigint,
    PRIMARY KEY (batch_id, task_id),
    CONSTRAINT listing_dispatch_items_batch_fk
        FOREIGN KEY (batch_id, org_id)
        REFERENCES public.listing_dispatch_batches(id, org_id),
    CONSTRAINT listing_dispatch_items_revision_positive CHECK (task_revision > 0),
    CONSTRAINT listing_dispatch_items_product_not_blank
        CHECK (length(btrim(supplier_product_id)) > 0),
    CONSTRAINT listing_dispatch_items_batch_bound
        CHECK (batch_item_index BETWEEN 0 AND 99),
    CONSTRAINT listing_dispatch_items_batch_slot_unique
        UNIQUE (batch_id, batch_item_index)
);

CREATE UNIQUE INDEX listing_dispatch_items_one_live_task_uidx
    ON public.listing_dispatch_items (task_id)
    WHERE released_at_ms IS NULL;

CREATE TABLE public.listing_dispatch_rejections (
    admission_id uuid NOT NULL,
    org_id bigint NOT NULL,
    task_id uuid NOT NULL,
    reason character varying(48) NOT NULL,
    created_at_ms bigint NOT NULL,
    PRIMARY KEY (admission_id, task_id),
    CONSTRAINT listing_dispatch_rejections_admission_fk
        FOREIGN KEY (admission_id, org_id)
        REFERENCES public.listing_dispatch_admissions(id, org_id),
    CONSTRAINT listing_dispatch_rejections_reason_known
        CHECK (reason IN (
            'task_not_found', 'task_not_ready', 'store_unavailable',
            'store_not_ready', 'supplier_config_invalid', 'revision_changed',
            'active_batch'
        ))
);

CREATE FUNCTION public.reject_live_listing_task_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.listing_dispatch_items i
        WHERE i.org_id = OLD.org_id AND i.task_id = OLD.id
          AND i.released_at_ms IS NULL
    ) THEN
        RAISE EXCEPTION 'listing task is occupied by a live dispatch batch'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER listing_tasks_reject_live_dispatch_mutation
BEFORE UPDATE OR DELETE ON public.listing_tasks
FOR EACH ROW EXECUTE FUNCTION public.reject_live_listing_task_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.listing_dispatch_admissions,
    public.listing_dispatch_batches,
    public.listing_dispatch_items,
    public.listing_dispatch_rejections
    TO podhub_app, podhub_worker;
GRANT SELECT ON TABLE public.store_seller_credentials
    TO podhub_app, podhub_worker;

ALTER TABLE public.listing_dispatch_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_dispatch_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.listing_dispatch_admissions
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.listing_dispatch_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_dispatch_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.listing_dispatch_batches
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.listing_dispatch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_dispatch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.listing_dispatch_items
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.listing_dispatch_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_dispatch_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.listing_dispatch_rejections
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
