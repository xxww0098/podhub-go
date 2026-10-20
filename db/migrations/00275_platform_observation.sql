-- +goose Up
-- declaration 275 PlatformObservation m20261012_000054_platform_observation
-- source: migration/src/platform_observation.rs @ a03d735
-- +goose StatementBegin
CREATE POLICY platform_observation_select ON public.console_store_metrics
        FOR SELECT TO podhub_app
        USING (EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
        ));

CREATE POLICY platform_observation_select ON public.store_product_sync
        FOR SELECT TO podhub_app
        USING (EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
        ));

CREATE POLICY platform_observation_select ON public.store_products
        FOR SELECT TO podhub_app
        USING (EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
        ));

CREATE POLICY platform_observation_select ON public.store_product_metrics
        FOR SELECT TO podhub_app
        USING (EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
        ));

CREATE POLICY platform_observation_select ON public.submission_intents
        FOR SELECT TO podhub_app
        USING (EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
        ));

CREATE POLICY platform_observation_select ON public.seller_upstream_writes
        FOR SELECT TO podhub_app
        USING (EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
        ));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
