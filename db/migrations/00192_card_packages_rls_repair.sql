-- +goose Up
-- declaration 192 CardPackagesRlsRepair m20260921_000331_card_packages_rls_repair
-- source: migration/src/card_packages_rls_repair.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.card_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_packages_author_isolation ON public.card_packages;
CREATE POLICY card_packages_author_isolation ON public.card_packages
    FOR ALL TO podhub_app
    USING (author_user_id = NULLIF(current_setting('app.current_user_id', true), '')::bigint)
    WITH CHECK (author_user_id = NULLIF(current_setting('app.current_user_id', true), '')::bigint);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
