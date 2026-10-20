-- +goose Up
-- declaration 68 RedeemWalletCredits m20260821_000230_redeem_wallet_credits
-- source: migration/src/redeem_wallet_credits.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.redeem_codes
    ADD COLUMN IF NOT EXISTS wallet_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.redeem_codes
    DROP CONSTRAINT IF EXISTS redeem_codes_product_shape;

ALTER TABLE public.redeem_codes
    ADD CONSTRAINT redeem_codes_product_shape CHECK (
        product IN ('store_slots', 'ocr_credits', 'wallet_credits')
        AND (
            (product = 'store_slots'
                AND store_slots >= 1 AND ocr_credits = 0 AND wallet_cents = 0)
            OR (product = 'ocr_credits'
                AND ocr_credits >= 1 AND store_slots = 0 AND wallet_cents = 0)
            OR (product = 'wallet_credits'
                AND wallet_cents >= 1 AND store_slots = 0 AND ocr_credits = 0)
        )
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
