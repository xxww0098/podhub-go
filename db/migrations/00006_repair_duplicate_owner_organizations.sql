-- +goose Up
-- +goose NO TRANSACTION
-- declaration 6 RepairDuplicateOwnerOrganizations m20260802_000030_repair_duplicate_owner_organizations
-- source: migration/src/uniqueness.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.seaql_migration_steps (
    migration_version character varying(255) NOT NULL,
    step_name character varying(255) NOT NULL,
    status character varying(16) NOT NULL,
    started_at bigint NOT NULL,
    completed_at bigint,
    detail text,
    CONSTRAINT seaql_migration_steps_status_check
        CHECK (status IN ('started', 'complete')),
    CONSTRAINT seaql_migration_steps_pkey
        PRIMARY KEY (migration_version, step_name)
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
