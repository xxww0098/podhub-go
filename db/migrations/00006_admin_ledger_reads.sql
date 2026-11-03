-- +goose Up
CREATE POLICY platform_observation_select ON public.ai_requests
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
    ));

CREATE POLICY platform_observation_select ON public.payment_orders
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
    ));

CREATE POLICY platform_admin_manage ON public.redeem_codes
    TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin' AND observer.disabled_at IS NULL
    ));

-- +goose Down
DROP POLICY platform_admin_manage ON public.redeem_codes;
DROP POLICY platform_observation_select ON public.payment_orders;
DROP POLICY platform_observation_select ON public.ai_requests;
