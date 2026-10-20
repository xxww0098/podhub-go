-- +goose Up
-- declaration 340 OzonErrorCatalogLogin
-- Post-Rust append. Does not alter migrations 00001-00320.
-- 00320 granted podhub_ozon_catalog only to the migration user. The API
-- session user is podhub_login_api. SET ROLE checks that session user, after
-- the transaction has already entered podhub_app. INHERIT is false so the
-- login does not gain the catalog table privileges until it sets the role.
-- The role stays NOLOGIN, NOSUPERUSER, NOBYPASSRLS. It is not granted to
-- PUBLIC or to podhub_worker.
-- +goose StatementBegin
GRANT podhub_ozon_catalog TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
-- +goose StatementEnd

-- +goose Down
-- Destructive rollback is refused. This append follows that shape.
SELECT 1;
