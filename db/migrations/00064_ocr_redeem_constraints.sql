-- +goose Up
-- declaration 64 OcrRedeemConstraints m20260822_000227_ocr_redeem_constraints
-- source: migration/src/ocr_redeem_constraints.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.redeem_codes
    DROP CONSTRAINT IF EXISTS redeem_codes_product_shape;

ALTER TABLE public.redeem_codes
    ADD CONSTRAINT redeem_codes_product_shape CHECK (
        product IN ('store_slots', 'ocr_credits')
        AND (
            (product = 'store_slots' AND store_slots >= 1 AND ocr_credits = 0)
            OR (product = 'ocr_credits' AND ocr_credits >= 1 AND store_slots = 0)
        )
    );

ALTER TABLE public.redeem_codes
    DROP CONSTRAINT IF EXISTS redeem_codes_duration_days_valid;

ALTER TABLE public.redeem_codes
    ADD CONSTRAINT redeem_codes_duration_days_valid
    CHECK (duration_days BETWEEN 1 AND 3650);

ALTER TABLE public.ocr_credit_lots
    DROP CONSTRAINT IF EXISTS ocr_credit_lots_expiry_after_start;

ALTER TABLE public.ocr_credit_lots
    ADD CONSTRAINT ocr_credit_lots_expiry_after_start
    CHECK (expires_at > starts_at);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
