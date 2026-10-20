-- +goose Up
-- declaration 46 PaymentOrders m20260818_000210_payment_orders
-- source: migration/src/payment_orders.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.payment_orders (
    id                  bigserial PRIMARY KEY,
    public_id           character varying(64) NOT NULL,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    plan                character varying(64) NOT NULL REFERENCES public.plans(key),
    months              integer NOT NULL,
    amount_cents        bigint NOT NULL,
    currency            character varying(8) NOT NULL,
    provider            character varying(32) NOT NULL,
    status              character varying(32) NOT NULL,
    provider_ref        character varying(128),
    created_by_user_id  bigint NOT NULL REFERENCES public.account_users(id),
    paid_at             timestamp with time zone,
    canceled_at         timestamp with time zone,
    created_at          timestamp with time zone NOT NULL,
    updated_at          timestamp with time zone NOT NULL,
    CONSTRAINT payment_orders_public_id_key UNIQUE (public_id),
    CONSTRAINT payment_orders_months_check CHECK (months >= 1),
    CONSTRAINT payment_orders_amount_check CHECK (amount_cents >= 0),
    CONSTRAINT payment_orders_status_check
        CHECK (status IN ('pending', 'paid', 'canceled'))
);

CREATE UNIQUE INDEX payment_orders_one_pending_per_org
    ON public.payment_orders (org_id)
    WHERE status = 'pending';

CREATE INDEX payment_orders_status_created_idx
    ON public.payment_orders (status, created_at DESC);

CREATE INDEX payment_orders_created_by_idx
    ON public.payment_orders (created_by_user_id, created_at DESC);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
