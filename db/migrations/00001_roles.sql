-- +goose Up
-- Runtime roles. Migrations run as the database owner; these roles are the
-- identities the API and workers enter with SET LOCAL ROLE, so none of them
-- may be a superuser or inherit across roles. The logins are NOINHERIT: a
-- login gains podhub_app or podhub_worker only for the transaction that sets
-- it, which is what makes RLS the tenant boundary.
--
-- Roles are cluster-wide, so every block tolerates an existing role: the
-- integration template is cloned from a cluster that already ran this file.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_app') THEN
        CREATE ROLE podhub_app NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_worker') THEN
        CREATE ROLE podhub_worker NOINHERIT BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_login_api') THEN
        CREATE ROLE podhub_login_api LOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_login_listing_worker') THEN
        CREATE ROLE podhub_login_listing_worker LOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_login_ai_media_worker') THEN
        CREATE ROLE podhub_login_ai_media_worker LOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_login_reconciler') THEN
        CREATE ROLE podhub_login_reconciler LOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_login_health') THEN
        CREATE ROLE podhub_login_health LOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_billing_lookup') THEN
        CREATE ROLE podhub_billing_lookup NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_error_prune') THEN
        CREATE ROLE podhub_error_prune NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_digest_platform') THEN
        CREATE ROLE podhub_digest_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_ozon_catalog') THEN
        CREATE ROLE podhub_ozon_catalog NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_ozon_sample_prune') THEN
        CREATE ROLE podhub_ozon_sample_prune NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_maintenance') THEN
        CREATE ROLE podhub_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
-- Membership is SET-only for every login: the privilege exists inside the
-- transaction that entered the role, never for the session's other statements.
GRANT podhub_app TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
GRANT podhub_app TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
GRANT podhub_app TO podhub_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_digest_platform TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_digest_platform TO podhub_login_ai_media_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_digest_platform TO podhub_login_listing_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_digest_platform TO podhub_login_reconciler WITH INHERIT FALSE, SET TRUE;
GRANT podhub_error_prune TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_error_prune TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
GRANT podhub_maintenance TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_maintenance TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_catalog TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_catalog TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_ai_media_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_listing_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_reconciler WITH INHERIT FALSE, SET TRUE;
GRANT podhub_worker TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
GRANT podhub_worker TO podhub_login_ai_media_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_worker TO podhub_login_listing_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_worker TO podhub_login_reconciler WITH INHERIT FALSE, SET TRUE;
-- +goose StatementEnd

-- +goose StatementBegin
-- The health login is the only one that needs an explicit CONNECT grant; the
-- rest reach the database through the role they set.
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO podhub_login_health', current_database());
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Roles are cluster-wide and shared with other databases. A rollback here
-- would break every other database on the cluster, so it refuses.
SELECT 1;
