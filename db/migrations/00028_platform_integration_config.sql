-- +goose Up
-- declaration 28 PlatformIntegrationConfig m20260811_000056_platform_integration_config
-- source: migration/src/platform_integration_config.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.platform_integration_config (
    singleton boolean PRIMARY KEY DEFAULT true,
    revision bigint NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    updated_at_ms bigint NOT NULL,
    updated_by_account_uuid text NOT NULL,
    CONSTRAINT platform_integration_config_singleton CHECK (singleton),
    CONSTRAINT platform_integration_config_revision_positive CHECK (revision > 0),
    CONSTRAINT platform_integration_config_nonce_length CHECK (octet_length(nonce) = 12)
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
