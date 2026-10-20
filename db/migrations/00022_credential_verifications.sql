-- +goose Up
-- declaration 22 CredentialVerifications m20260805_000050_credential_verifications
-- source: migration/src/credential_verifications.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.store_credential_verifications (
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    store_id bigint NOT NULL REFERENCES public.organization_stores(id),
    device_id bigint NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    credential_revision bigint NOT NULL,
    verified boolean NOT NULL,
    verified_at_ms bigint NOT NULL,
    failure_code character varying(128),
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT store_credential_verifications_pkey
        PRIMARY KEY (org_id, store_id, device_id, credential_revision),
    CONSTRAINT ck_store_credential_verifications_credential_revision
        CHECK (credential_revision >= 1),
    CONSTRAINT ck_store_credential_verifications_verified_at_ms
        CHECK (verified_at_ms >= 0),
    CONSTRAINT ck_store_credential_verifications_failure_code
        CHECK (
            failure_code IS NULL
            OR (
                length(btrim(failure_code)) BETWEEN 1 AND 128
                AND failure_code !~ '[[:space:]]'
            )
        )
);

CREATE INDEX IF NOT EXISTS store_credential_verifications_summary_idx
    ON public.store_credential_verifications
       (org_id, store_id, credential_revision, verified_at_ms DESC);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
