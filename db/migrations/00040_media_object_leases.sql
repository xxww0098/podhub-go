-- +goose Up
-- declaration 40 MediaObjectLeases m20260818_000204_media_object_leases
-- source: migration/src/media_object_leases.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.media_object_leases (
    team_uuid            uuid NOT NULL,
    content_hash         character varying(64) NOT NULL,
    org_id               bigint NOT NULL REFERENCES public.organizations(id),
    object_key           text NOT NULL,
    media_account_id     character varying(128) NOT NULL,
    first_seen_at        timestamp with time zone NOT NULL,
    birth_local_date     date NOT NULL,
    hits_on_birth_date   integer NOT NULL,
    ttl_days             smallint NOT NULL,
    last_hit_at          timestamp with time zone NOT NULL,
    expires_at           timestamp with time zone NOT NULL,
    deleted_at           timestamp with time zone,
    gc_claim_token       uuid,
    gc_claimed_at        timestamp with time zone,
    created_at           timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at           timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (team_uuid, content_hash),
    CONSTRAINT ck_media_object_leases_hash
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_media_object_leases_hits
        CHECK (hits_on_birth_date >= 1),
    CONSTRAINT ck_media_object_leases_ttl
        CHECK (ttl_days IN (1, 2)),
    CONSTRAINT ck_media_object_leases_key
        CHECK (length(btrim(object_key)) > 0),
    CONSTRAINT ck_media_object_leases_gc_claim
        CHECK ((gc_claim_token IS NULL) = (gc_claimed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_media_object_leases_due
    ON public.media_object_leases (expires_at)
    WHERE deleted_at IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
