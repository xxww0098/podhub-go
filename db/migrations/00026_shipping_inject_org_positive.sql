-- +goose Up
-- +goose StatementBegin
-- The two shipping injection tables are org-scoped policies from 00024 but
-- predate the rule that org_id can only hold an existing organizations.id.
-- Pin them with the same positive-id guard the other policy tables already
-- carry, so a session cannot match an org_id=0 row through the GUC.
ALTER TABLE public.shipping_inject_operations
    ADD CONSTRAINT ck_shipping_inject_operations_org_positive CHECK (org_id > 0);
ALTER TABLE public.shipping_shop_injections
    ADD CONSTRAINT ck_shipping_shop_injections_org_positive CHECK (org_id > 0);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE public.shipping_shop_injections
    DROP CONSTRAINT IF EXISTS ck_shipping_shop_injections_org_positive;
ALTER TABLE public.shipping_inject_operations
    DROP CONSTRAINT IF EXISTS ck_shipping_inject_operations_org_positive;
-- +goose StatementEnd
