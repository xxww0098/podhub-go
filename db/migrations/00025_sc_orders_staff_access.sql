-- +goose Up
-- +goose StatementBegin
-- The admin procurement console reads orders across organizations without an
-- app.current_org_id. Give platform staff the same staff_all arm that the
-- catalogue tables already expose; tenant_isolation and worker_claim stay in
-- place for app and worker sessions.
DO $$
BEGIN
    DROP POLICY IF EXISTS staff_all ON public.sc_orders;
    CREATE POLICY staff_all ON public.sc_orders TO podhub_app
        USING (current_setting('app.staff_access', true) = '1')
        WITH CHECK (current_setting('app.staff_access', true) = '1');
    DROP POLICY IF EXISTS staff_all ON public.sc_order_lines;
    CREATE POLICY staff_all ON public.sc_order_lines TO podhub_app
        USING (current_setting('app.staff_access', true) = '1')
        WITH CHECK (current_setting('app.staff_access', true) = '1');
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP POLICY IF EXISTS staff_all ON public.sc_order_lines;
DROP POLICY IF EXISTS staff_all ON public.sc_orders;
-- +goose StatementEnd
