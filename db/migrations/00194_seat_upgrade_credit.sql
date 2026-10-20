-- +goose Up
-- declaration 194 SeatUpgradeCredit m20260921_000330_seat_upgrade_credit
-- source: migration/src/seat_upgrade_credit.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS credit_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS credit_lots jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_credit_check;

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_credit_check CHECK (credit_cents >= 0);

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_credit_shape;

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_credit_shape CHECK (
        jsonb_typeof(credit_lots) = 'array'
        AND (credit_cents = 0 OR product = 'member_seats'));

CREATE TABLE IF NOT EXISTS public.member_seat_lot_credits (
    id                   bigserial PRIMARY KEY,
    order_id             bigint NOT NULL REFERENCES public.payment_orders(id),
    lot_id               bigint NOT NULL REFERENCES public.member_seat_lots(id),
    org_id               bigint NOT NULL REFERENCES public.organizations(id),
    tier                 text NOT NULL,
    seats                integer NOT NULL,
    starts_at            timestamp with time zone NOT NULL,
    expires_at           timestamp with time zone NOT NULL,
    total_days           integer NOT NULL,
    used_days            integer NOT NULL,
    remaining_days       integer NOT NULL,
    lot_value_cents      bigint NOT NULL,
    consumed_value_cents bigint NOT NULL,
    terminated_at        timestamp with time zone,
    created_at           timestamp with time zone NOT NULL,
    CONSTRAINT member_seat_lot_credits_lot_key UNIQUE (lot_id),
    CONSTRAINT member_seat_lot_credits_days CHECK (
        total_days >= 1
        AND used_days >= 0
        AND remaining_days >= 0
        AND used_days + remaining_days = total_days),
    CONSTRAINT member_seat_lot_credits_amounts CHECK (
        lot_value_cents >= 0
        AND consumed_value_cents >= 0
        AND consumed_value_cents <= lot_value_cents)
);

CREATE INDEX IF NOT EXISTS member_seat_lot_credits_order_idx
    ON public.member_seat_lot_credits (order_id);

GRANT SELECT, INSERT ON TABLE public.member_seat_lot_credits TO podhub_app, podhub_worker;

GRANT USAGE, SELECT ON SEQUENCE public.member_seat_lot_credits_id_seq TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
