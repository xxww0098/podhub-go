-- +goose Up
-- declaration 276 StoreCredentialEnvelope m20261013_000055_store_credential_envelope
-- source: migration/src/store_credential_envelope.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_seller_credentials
    ADD COLUMN IF NOT EXISTS wrapped_dek bytea,
    ADD COLUMN IF NOT EXISTS dek_nonce bytea,
    ADD COLUMN IF NOT EXISTS envelope_version smallint NOT NULL DEFAULT 1;

ALTER TABLE public.store_seller_credentials
    ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.store_seller_credentials
    DROP CONSTRAINT IF EXISTS ck_store_seller_credentials_client_id;

ALTER TABLE public.store_seller_credentials
    ADD CONSTRAINT ck_store_seller_credentials_envelope
    CHECK (
        (
            envelope_version = 1
            AND client_id IS NOT NULL
            AND length(btrim(client_id)) > 0
            AND wrapped_dek IS NULL
            AND dek_nonce IS NULL
        )
        OR (
            envelope_version = 2
            AND client_id IS NULL
            AND octet_length(wrapped_dek) = 48
            AND octet_length(dek_nonce) = 12
        )
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
