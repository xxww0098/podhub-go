-- +goose Up
-- declaration 161 PlatformCatalogFetchWbToken m20260914_000305_platform_catalog_fetch_wb_token
-- source: migration/src/platform_catalog_fetch_wb_token.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.platform_catalog_fetch_config
    ADD COLUMN IF NOT EXISTS wb_credential_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS wb_last_verified_at_ms bigint,
    ADD COLUMN IF NOT EXISTS wb_token_key_id character varying(32),
    ADD COLUMN IF NOT EXISTS wb_token_nonce bytea,
    ADD COLUMN IF NOT EXISTS wb_token_ciphertext bytea;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'platform_catalog_fetch_wb_token_envelope_complete'
          AND conrelid = 'public.platform_catalog_fetch_config'::regclass
    ) THEN
        ALTER TABLE public.platform_catalog_fetch_config
            ADD CONSTRAINT platform_catalog_fetch_wb_token_envelope_complete CHECK (
                (wb_token_key_id IS NULL AND wb_token_nonce IS NULL AND wb_token_ciphertext IS NULL)
                OR
                (wb_token_key_id IS NOT NULL AND wb_token_nonce IS NOT NULL AND wb_token_ciphertext IS NOT NULL)
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'platform_catalog_fetch_wb_token_envelope_shape'
          AND conrelid = 'public.platform_catalog_fetch_config'::regclass
    ) THEN
        ALTER TABLE public.platform_catalog_fetch_config
            ADD CONSTRAINT platform_catalog_fetch_wb_token_envelope_shape CHECK (
                wb_token_key_id IS NULL
                OR (
                    length(btrim(wb_token_key_id)) > 0
                    AND octet_length(wb_token_nonce) = 12
                    AND octet_length(wb_token_ciphertext) BETWEEN 17 AND 32768
                )
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'platform_catalog_fetch_wb_revision_nonnegative'
          AND conrelid = 'public.platform_catalog_fetch_config'::regclass
    ) THEN
        ALTER TABLE public.platform_catalog_fetch_config
            ADD CONSTRAINT platform_catalog_fetch_wb_revision_nonnegative
                CHECK (wb_credential_revision >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'platform_catalog_fetch_wb_state_consistent'
          AND conrelid = 'public.platform_catalog_fetch_config'::regclass
    ) THEN
        ALTER TABLE public.platform_catalog_fetch_config
            ADD CONSTRAINT platform_catalog_fetch_wb_state_consistent CHECK (
                (wb_token_ciphertext IS NULL AND wb_credential_revision = 0 AND wb_last_verified_at_ms IS NULL)
                OR
                (wb_token_ciphertext IS NOT NULL AND wb_credential_revision > 0 AND wb_last_verified_at_ms IS NOT NULL)
            );
    END IF;
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
