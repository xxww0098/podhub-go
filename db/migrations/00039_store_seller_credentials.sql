-- +goose Up
-- +goose NO TRANSACTION
-- declaration 39 StoreSellerCredentials m20260817_000203_store_seller_credentials
-- source: migration/src/store_seller_credentials.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.store_seller_credentials (
    store_id                bigint PRIMARY KEY
                              REFERENCES public.organization_stores(id) ON DELETE CASCADE,
    org_id                  bigint NOT NULL REFERENCES public.organizations(id),
    credential_revision     bigint NOT NULL,
    client_id               character varying(128) NOT NULL,
    key_id                  character varying(64) NOT NULL,
    nonce                   bytea NOT NULL,
    ciphertext              bytea NOT NULL,
    key_fingerprint         bytea NOT NULL,
    registered_by_user_id   bigint NOT NULL REFERENCES public.account_users(id),
    registered_by_device_id bigint REFERENCES public.devices(id) ON DELETE SET NULL,
    registered_at_ms        bigint NOT NULL,
    rotated_at_ms           bigint,
    last_leased_at_ms       bigint,
    created_at              timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at              timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_store_seller_credentials_nonce
        CHECK (octet_length(nonce) = 12),
    CONSTRAINT ck_store_seller_credentials_ciphertext
        CHECK (octet_length(ciphertext) BETWEEN 17 AND 4096),
    CONSTRAINT ck_store_seller_credentials_fingerprint
        CHECK (octet_length(key_fingerprint) = 32),
    CONSTRAINT ck_store_seller_credentials_revision
        CHECK (credential_revision >= 1),
    CONSTRAINT ck_store_seller_credentials_client_id
        CHECK (length(btrim(client_id)) > 0)
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_store_seller_credentials_org" ON "public"."store_seller_credentials" ("org_id", "store_id");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_store_seller_credentials_key_id" ON "public"."store_seller_credentials" ("key_id");
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS owned_by_membership_id bigint
        REFERENCES public.organization_members(id) ON DELETE RESTRICT;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_organization_stores_owner" ON "public"."organization_stores" ("org_id", "owned_by_membership_id") WHERE deleted_at_ms IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
