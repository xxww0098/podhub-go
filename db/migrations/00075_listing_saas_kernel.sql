-- +goose Up
-- declaration 75 ListingSaasKernel m20260825_000237_listing_saas_kernel
-- source: migration/src/listing_saas_kernel.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.jobs (
    id                uuid PRIMARY KEY,
    org_id            bigint NOT NULL REFERENCES public.organizations(id),
    kind              text NOT NULL,
    aggregate_type    text NOT NULL,
    aggregate_id      uuid NOT NULL,
    input_revision    bigint NOT NULL,
    idempotency_key   text NOT NULL,
    priority          smallint NOT NULL DEFAULT 100,
    state             text NOT NULL,
    run_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    attempt           integer NOT NULL DEFAULT 0,
    max_attempts      integer NOT NULL DEFAULT 8,
    lease_owner       text,
    lease_until       timestamptz,
    payload           jsonb NOT NULL,
    result_ref        jsonb,
    trace_id          text,
    cancel_requested_at timestamptz,
    last_error_code   text,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT jobs_state_known CHECK (state IN (
        'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'
    )),
    CONSTRAINT jobs_attempt_nonneg CHECK (attempt >= 0),
    CONSTRAINT jobs_max_attempts_pos CHECK (max_attempts > 0),
    CONSTRAINT jobs_org_kind_idempotency UNIQUE (org_id, kind, idempotency_key)
);

CREATE INDEX jobs_claim_idx
    ON public.jobs (kind, priority ASC, run_at ASC, created_at ASC)
    WHERE state IN ('queued', 'retry_wait');

CREATE INDEX jobs_lease_expiry_idx
    ON public.jobs (lease_until)
    WHERE state = 'running';

CREATE TABLE public.listing_rows (
    id                  uuid PRIMARY KEY,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    card_id             uuid NOT NULL,
    store_id            uuid,
    revision            bigint NOT NULL DEFAULT 1,
    content_state       text NOT NULL DEFAULT 'draft',
    media_state         text NOT NULL DEFAULT 'pending',
    validation_state    text NOT NULL DEFAULT 'stale',
    submission_state    text NOT NULL DEFAULT 'none',
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    field_sources       jsonb NOT NULL DEFAULT '{}'::jsonb,
    schema_revision     text,
    created_by          bigint,
    updated_by          bigint,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT listing_rows_revision_pos CHECK (revision >= 1),
    CONSTRAINT listing_rows_content_state_known CHECK (content_state IN (
        'draft', 'recognizing', 'ready', 'failed'
    )),
    CONSTRAINT listing_rows_media_state_known CHECK (media_state IN (
        'pending', 'processing', 'ready', 'failed'
    )),
    CONSTRAINT listing_rows_validation_state_known CHECK (validation_state IN (
        'stale', 'blocked', 'passed'
    )),
    CONSTRAINT listing_rows_submission_state_known CHECK (submission_state IN (
        'none', 'queued', 'submitting', 'unknown', 'accepted', 'rejected'
    ))
);

CREATE INDEX listing_rows_org_card_idx
    ON public.listing_rows (org_id, card_id);

CREATE INDEX listing_rows_org_updated_idx
    ON public.listing_rows (org_id, updated_at DESC);

CREATE TABLE public.submission_intents (
    id                    uuid PRIMARY KEY,
    org_id                bigint NOT NULL REFERENCES public.organizations(id),
    store_id              uuid NOT NULL,
    listing_row_id        uuid NOT NULL REFERENCES public.listing_rows(id),
    row_revision          bigint NOT NULL,
    client_operation_id   text NOT NULL,
    request_hash          text NOT NULL,
    state                 text NOT NULL,
    external_task_id      text,
    last_error_code       text,
    reconcile_after       timestamptz,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT submission_intents_state_known CHECK (state IN (
        'queued', 'submitting', 'unknown', 'accepted', 'rejected', 'cancelled'
    )),
    CONSTRAINT submission_intents_row_revision UNIQUE (
        org_id, store_id, listing_row_id, row_revision
    ),
    CONSTRAINT submission_intents_client_op UNIQUE (
        org_id, store_id, client_operation_id
    )
);

CREATE INDEX submission_intents_reconcile_idx
    ON public.submission_intents (reconcile_after)
    WHERE state = 'unknown';

CREATE TABLE public.usage_reservations (
    id                uuid PRIMARY KEY,
    org_id            bigint NOT NULL REFERENCES public.organizations(id),
    job_id            uuid NOT NULL REFERENCES public.jobs(id),
    resource_kind     text NOT NULL,
    estimated_units   bigint NOT NULL,
    finalized_units   bigint,
    state             text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT usage_reservations_job_unique UNIQUE (job_id),
    CONSTRAINT usage_reservations_estimated_nonneg CHECK (estimated_units >= 0),
    CONSTRAINT usage_reservations_state_known CHECK (state IN (
        'reserved', 'finalized', 'released', 'uncertain'
    ))
);

CREATE INDEX usage_reservations_org_state_idx
    ON public.usage_reservations (org_id, state);

CREATE TABLE public.outbox_events (
    id              uuid PRIMARY KEY,
    org_id          bigint NOT NULL REFERENCES public.organizations(id),
    topic           text NOT NULL,
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at    timestamptz
);

CREATE INDEX outbox_events_unpublished_idx
    ON public.outbox_events (created_at ASC)
    WHERE published_at IS NULL;

CREATE TABLE public.inbox_receipts (
    consumer        text NOT NULL,
    event_id        uuid NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (consumer, event_id)
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
