-- +goose Up
-- declaration 202 PurchaseAgreement m20260921_100000_purchase_agreement
-- source: migration/src/purchase_agreement.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders ADD COLUMN purchase_agreement jsonb;
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_purchase_agreement_valid
CHECK (purchase_agreement IS NULL OR (
    product = 'member_seats'
    AND jsonb_typeof(purchase_agreement) = 'object'
    AND purchase_agreement ?& ARRAY['version','title','effective_at','content','accepted_at','accepted_by']
    AND jsonb_typeof(purchase_agreement->'version') = 'string'
    AND jsonb_typeof(purchase_agreement->'title') = 'string'
    AND jsonb_typeof(purchase_agreement->'effective_at') = 'string'
    AND jsonb_typeof(purchase_agreement->'content') = 'string'
    AND jsonb_typeof(purchase_agreement->'accepted_at') = 'string'
    AND jsonb_typeof(purchase_agreement->'accepted_by') = 'string'
    AND length(purchase_agreement->>'version') > 0
    AND length(purchase_agreement->>'content') > 0
    AND length(purchase_agreement->>'accepted_at') > 0
    AND purchase_agreement->>'accepted_by' = created_by_user_id::text
));
CREATE FUNCTION public.payment_order_agreement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.purchase_agreement IS DISTINCT FROM OLD.purchase_agreement THEN
        RAISE EXCEPTION 'payment order purchase agreement is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER payment_order_agreement_immutable BEFORE UPDATE OF purchase_agreement
ON public.payment_orders FOR EACH ROW EXECUTE FUNCTION public.payment_order_agreement_immutable();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
