-- +goose Up
-- declaration 2 MigrationStepMarkers m20260802_000002_migration_step_markers
-- source: migration/src/migrator/baseline.rs @ a03d735
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
