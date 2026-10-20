-- +goose Up
-- declaration 74 PaymentOrderLaunch m20260824_000236_payment_order_launch
-- source: migration/src/payment_order_launch.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders
    ADD COLUMN qr_code text,
    ADD COLUMN pay_url text,
    ADD CONSTRAINT payment_orders_qr_code_size
        CHECK (qr_code IS NULL OR octet_length(qr_code) <= 16384),
    ADD CONSTRAINT payment_orders_pay_url_size
        CHECK (pay_url IS NULL OR octet_length(pay_url) <= 4096),
    ADD CONSTRAINT payment_orders_terminal_has_no_launch
        CHECK (status = 'pending' OR (qr_code IS NULL AND pay_url IS NULL));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
