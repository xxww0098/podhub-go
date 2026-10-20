-- +goose Up
-- declaration 189 PaymentOrderOperation m20260920_000327_payment_order_operation
-- source: migration/src/payment_order_operation.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS operation_id character varying(64),
    ADD COLUMN IF NOT EXISTS launch_state character varying(32);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'payment_orders_launch_state_known'
           AND conrelid = 'public.payment_orders'::regclass
    ) THEN
        ALTER TABLE public.payment_orders
            ADD CONSTRAINT payment_orders_launch_state_known
                CHECK (launch_state IS NULL OR launch_state IN ('entry_confirming'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'payment_orders_terminal_has_no_launch_state'
           AND conrelid = 'public.payment_orders'::regclass
    ) THEN
        ALTER TABLE public.payment_orders
            ADD CONSTRAINT payment_orders_terminal_has_no_launch_state
                CHECK (status = 'pending' OR launch_state IS NULL);
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_operation_uidx
    ON public.payment_orders (org_id, operation_id)
    WHERE operation_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
