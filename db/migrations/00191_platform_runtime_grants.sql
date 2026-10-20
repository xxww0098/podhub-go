-- +goose Up
-- declaration 191 PlatformRuntimeGrants m20260920_000329_platform_runtime_grants
-- source: migration/src/platform_runtime_grants.rs @ a03d735
-- +goose StatementBegin
GRANT USAGE ON SCHEMA public TO podhub_app, podhub_worker;

DO $$
DECLARE
    target record;
BEGIN
    FOR target IN
        SELECT n.nspname AS nsp, c.relname AS name, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'S')
          AND c.relname NOT LIKE 'seaql_%'
        ORDER BY c.relkind, c.relname
    LOOP
        IF target.relkind = 'S' THEN
            EXECUTE format(
                'GRANT USAGE, SELECT ON SEQUENCE %I.%I TO podhub_app, podhub_worker',
                target.nsp, target.name
            );
        ELSIF target.name = 'inbox_receipts' THEN
            EXECUTE format(
                'GRANT SELECT, INSERT ON TABLE %I.%I TO podhub_worker',
                target.nsp, target.name
            );
        ELSE
            EXECUTE format(
                'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO podhub_app, podhub_worker',
                target.nsp, target.name
            );
        END IF;
    END LOOP;
END
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO podhub_app, podhub_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO podhub_app, podhub_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO podhub_app, podhub_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
