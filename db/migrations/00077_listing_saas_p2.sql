-- +goose Up
-- declaration 77 ListingSaasP2 m20260825_000239_listing_saas_p2
-- source: migration/src/listing_saas_p2.rs @ a03d735
-- +goose StatementBegin
-- Immutable physical bytes. Dedup key is (org_id, sha256) — never cross-tenant.
CREATE TABLE public.media_blobs (
    id              uuid PRIMARY KEY,
    org_id          bigint NOT NULL REFERENCES public.organizations(id),
    sha256          text NOT NULL,
    size_bytes      bigint NOT NULL,
    mime            text NOT NULL,
    storage_key     text NOT NULL,
    state           text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT media_blobs_size_nonneg CHECK (size_bytes >= 0),
    CONSTRAINT media_blobs_sha256_shape CHECK (
        length(sha256) = 64 AND sha256 ~ '^[0-9a-f]+$'
    ),
    CONSTRAINT media_blobs_state_known CHECK (state IN (
        'uploading', 'verified', 'quarantined', 'gc_pending', 'deleted'
    )),
    CONSTRAINT media_blobs_org_sha UNIQUE (org_id, sha256)
);

CREATE INDEX media_blobs_org_state_idx
    ON public.media_blobs (org_id, state);

-- Tenant-visible logical resource. Soft-delete only; GC waits on bindings.
CREATE TABLE public.media_lib_assets (
    id              uuid PRIMARY KEY,
    org_id          bigint NOT NULL REFERENCES public.organizations(id),
    blob_id         uuid NOT NULL REFERENCES public.media_blobs(id),
    kind            text NOT NULL,
    display_name    text NOT NULL DEFAULT '',
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL,
    version         bigint NOT NULL DEFAULT 1,
    created_by      bigint,
    deleted_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT media_lib_assets_version_pos CHECK (version >= 1),
    CONSTRAINT media_lib_assets_kind_known CHECK (kind IN (
        'image', 'video', 'document', 'other'
    )),
    CONSTRAINT media_lib_assets_status_known CHECK (status IN (
        'ready', 'processing', 'failed', 'deleted'
    ))
);

CREATE INDEX media_lib_assets_org_updated_idx
    ON public.media_lib_assets (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX media_lib_assets_blob_idx
    ON public.media_lib_assets (blob_id)
    WHERE deleted_at IS NULL;

CREATE TABLE public.media_variants (
    id              uuid PRIMARY KEY,
    org_id          bigint NOT NULL REFERENCES public.organizations(id),
    asset_id        uuid NOT NULL REFERENCES public.media_lib_assets(id),
    blob_id         uuid NOT NULL REFERENCES public.media_blobs(id),
    spec_hash       text NOT NULL,
    kind            text NOT NULL,
    width           integer,
    height          integer,
    status          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT media_variants_status_known CHECK (status IN (
        'pending', 'ready', 'failed'
    )),
    CONSTRAINT media_variants_asset_spec UNIQUE (org_id, asset_id, spec_hash)
);

CREATE INDEX media_variants_asset_idx
    ON public.media_variants (org_id, asset_id);

-- Pins an asset revision to a domain entity (listing row, preset, job, …).
CREATE TABLE public.media_bindings (
    id                  uuid PRIMARY KEY,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    asset_id            uuid NOT NULL REFERENCES public.media_lib_assets(id),
    entity_type         text NOT NULL,
    entity_id           uuid NOT NULL,
    purpose             text NOT NULL,
    pinned_revision     bigint NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    released_at         timestamptz,
    CONSTRAINT media_bindings_pinned_pos CHECK (pinned_revision >= 1)
);

CREATE UNIQUE INDEX media_bindings_live_unique
    ON public.media_bindings (org_id, asset_id, entity_type, entity_id, purpose)
    WHERE released_at IS NULL;

CREATE INDEX media_bindings_asset_live_idx
    ON public.media_bindings (org_id, asset_id)
    WHERE released_at IS NULL;

CREATE INDEX media_bindings_entity_idx
    ON public.media_bindings (org_id, entity_type, entity_id)
    WHERE released_at IS NULL;

-- Presign → finalize session. Idempotent on (org_id, idempotency_key).
CREATE TABLE public.media_uploads (
    id                  uuid PRIMARY KEY,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    idempotency_key     text NOT NULL,
    expected_sha256     text NOT NULL,
    expected_size       bigint NOT NULL,
    expected_mime       text NOT NULL,
    storage_key         text NOT NULL,
    state               text NOT NULL,
    blob_id             uuid REFERENCES public.media_blobs(id),
    asset_id            uuid REFERENCES public.media_lib_assets(id),
    created_by          bigint,
    expires_at          timestamptz NOT NULL,
    finalized_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT media_uploads_size_nonneg CHECK (expected_size >= 0),
    CONSTRAINT media_uploads_sha_shape CHECK (
        length(expected_sha256) = 64 AND expected_sha256 ~ '^[0-9a-f]+$'
    ),
    CONSTRAINT media_uploads_state_known CHECK (state IN (
        'pending', 'finalized', 'expired', 'aborted'
    )),
    CONSTRAINT media_uploads_org_idempotency UNIQUE (org_id, idempotency_key)
);

CREATE INDEX media_uploads_org_state_idx
    ON public.media_uploads (org_id, state, expires_at);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
