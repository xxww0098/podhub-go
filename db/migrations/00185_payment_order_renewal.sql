-- +goose Up
-- declaration 185 PaymentOrderRenewal m20260917_000323_payment_order_renewal
-- source: migration/src/payment_order_renewal.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders 
                 ADD COLUMN IF NOT EXISTS renews_lot_id bigint;

ALTER TABLE public.member_seat_lots 
                 ADD COLUMN IF NOT EXISTS renews_lot_id bigint;

DO $$
                   BEGIN
                       IF NOT EXISTS (
                           SELECT 1 FROM pg_constraint
                            WHERE conname = 'payment_orders_renews_lot_fkey'
                              AND conrelid = 'public.payment_orders'::regclass
                       ) THEN
                           ALTER TABLE public.payment_orders
                               ADD CONSTRAINT payment_orders_renews_lot_fkey
                                   FOREIGN KEY (renews_lot_id)
                                   REFERENCES public.member_seat_lots(id);
                       END IF;
                   END
                   $$;

DO $$
                   BEGIN
                       IF NOT EXISTS (
                           SELECT 1 FROM pg_constraint
                            WHERE conname = 'member_seat_lots_renews_lot_fkey'
                              AND conrelid = 'public.member_seat_lots'::regclass
                       ) THEN
                           ALTER TABLE public.member_seat_lots
                               ADD CONSTRAINT member_seat_lots_renews_lot_fkey
                                   FOREIGN KEY (renews_lot_id)
                                   REFERENCES public.member_seat_lots(id);
                       END IF;
                   END
                   $$;

CREATE UNIQUE INDEX IF NOT EXISTS member_seat_lots_renews_lot_uidx 
                 ON public.member_seat_lots (renews_lot_id) 
                 WHERE renews_lot_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
