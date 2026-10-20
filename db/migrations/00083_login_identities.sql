-- +goose Up
-- declaration 83 LoginIdentities m20260826_000244_login_identities
-- source: migration/src/login_identities.rs @ a03d735
-- +goose StatementBegin
DO $$
BEGIN

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_login_api')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_api') THEN
            ALTER ROLE ozon_pod_login_api RENAME TO podhub_login_api;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_login_api')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_api') THEN
            ALTER ROLE podx_login_api RENAME TO podhub_login_api;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_login_api LOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_login_listing_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_listing_worker') THEN
            ALTER ROLE ozon_pod_login_listing_worker RENAME TO podhub_login_listing_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_login_listing_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_listing_worker') THEN
            ALTER ROLE podx_login_listing_worker RENAME TO podhub_login_listing_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_login_listing_worker LOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_login_ai_media_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_ai_media_worker') THEN
            ALTER ROLE ozon_pod_login_ai_media_worker RENAME TO podhub_login_ai_media_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_login_ai_media_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_ai_media_worker') THEN
            ALTER ROLE podx_login_ai_media_worker RENAME TO podhub_login_ai_media_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_login_ai_media_worker LOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_login_reconciler')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_reconciler') THEN
            ALTER ROLE ozon_pod_login_reconciler RENAME TO podhub_login_reconciler;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_login_reconciler')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_reconciler') THEN
            ALTER ROLE podx_login_reconciler RENAME TO podhub_login_reconciler;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_login_reconciler LOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_login_health')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_health') THEN
            ALTER ROLE ozon_pod_login_health RENAME TO podhub_login_health;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_login_health')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_login_health') THEN
            ALTER ROLE podx_login_health RENAME TO podhub_login_health;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_login_health LOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
END
$$;

GRANT podhub_app TO podhub_login_api;
GRANT podhub_worker TO podhub_login_listing_worker;
GRANT podhub_worker TO podhub_login_ai_media_worker;
GRANT podhub_worker TO podhub_login_reconciler;
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO podhub_login_health', current_database());
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
