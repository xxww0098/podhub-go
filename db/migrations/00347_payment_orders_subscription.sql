-- +goose Up
-- +goose StatementBegin
-- Subscription orders reuse payment_orders.plan (the target plan) and .months
-- (1/3/6/12); every other detail lives in subscription_snapshot so a later
-- catalogue edit cannot change what was bought. No new status value: an order
-- that needs a human carries reconciliation_reason instead.
ALTER TABLE public.payment_orders
    ADD COLUMN subscription_snapshot    jsonb,
    ADD COLUMN payment_deadline_at      timestamptz,
    ADD COLUMN fulfillment_failed_at    timestamptz,
    ADD COLUMN reconciliation_reason    text
        CHECK (reconciliation_reason IS NULL OR reconciliation_reason IN (
            'amount_mismatch', 'fulfilled_after_cancel', 'term_shortened', 'superseded_change'));

-- Only subscription orders carry a snapshot, and every subscription order
-- must carry one.
ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_subscription_snapshot_shape;
ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_subscription_snapshot_shape CHECK (
        (product = 'subscription') = (subscription_snapshot IS NOT NULL));

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_product_known;
-- member_seats stays in the allowed set: historical rows still carry it and
-- a CHECK validates every row, not only new ones. The shape constraint below
-- no longer has a member_seats branch, so new rows of that product cannot be
-- inserted; the value is only readable history.
ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_known CHECK (
        product IN ('subscription', 'wallet_topup', 'platform_goods', 'member_seats'));

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_product_shape;
ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_shape CHECK (
        (product = 'subscription' AND subscription_snapshot IS NOT NULL
            AND member_seats IS NULL AND topup_microfen IS NULL)
        OR (product = 'wallet_topup' AND topup_microfen > 0)
        OR (product = 'platform_goods' AND topup_microfen IS NULL
            AND (member_seats IS NULL OR member_seats = 0)));

-- The purchase agreement is required for a subscription order, not for the
-- other products.
ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_purchase_agreement_valid;
ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_purchase_agreement_valid CHECK (
        (product <> 'subscription' AND purchase_agreement IS NULL)
        OR (product = 'subscription'
            AND jsonb_typeof(purchase_agreement) = 'object'
            AND purchase_agreement ?& ARRAY['version', 'title', 'effective_at', 'content', 'accepted_at', 'accepted_by']
            AND jsonb_typeof(purchase_agreement->'version') = 'string'
            AND jsonb_typeof(purchase_agreement->'title') = 'string'
            AND jsonb_typeof(purchase_agreement->'effective_at') = 'string'
            AND jsonb_typeof(purchase_agreement->'content') = 'string'
            AND jsonb_typeof(purchase_agreement->'accepted_at') = 'string'
            AND jsonb_typeof(purchase_agreement->'accepted_by') = 'string'
            AND length(purchase_agreement->>'version') > 0
            AND length(purchase_agreement->>'content') > 0
            AND length(purchase_agreement->>'accepted_at') > 0
            AND purchase_agreement->>'accepted_by' = created_by_user_id::text));

-- The old seat-sale constraints describe products that no longer exist.
ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_member_seat_terms;
ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_credit_shape;

-- Snapshot immutability, matching payment_order_agreement_immutable.
CREATE FUNCTION public.payment_order_subscription_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.subscription_snapshot IS DISTINCT FROM OLD.subscription_snapshot THEN
        RAISE EXCEPTION 'payment order subscription snapshot is immutable';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER payment_order_subscription_immutable
    BEFORE UPDATE OF subscription_snapshot ON public.payment_orders
    FOR EACH ROW EXECUTE FUNCTION public.payment_order_subscription_immutable();

-- The reaper scans pending rows by deadline.
CREATE INDEX payment_orders_deadline_idx
    ON public.payment_orders (payment_deadline_at)
    WHERE status = 'pending' AND payment_deadline_at IS NOT NULL;

-- A subscription order is created against a quote; the quote row is the
-- only place the amount was computed.
ALTER TABLE public.payment_orders
    ADD COLUMN quote_id uuid REFERENCES public.subscription_quotes (id);
CREATE UNIQUE INDEX payment_orders_quote_uidx
    ON public.payment_orders (quote_id)
    WHERE quote_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
SELECT 1;
