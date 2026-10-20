-- +goose Up
-- declaration 50 AiWalletContract m20260819_000214_ai_wallet_contract
-- source: migration/src/ai_wallet_contract.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders
    ALTER COLUMN plan DROP NOT NULL;

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_shape CHECK (
        (product = 'team_plan' AND plan IS NOT NULL AND topup_microfen IS NULL)
        OR (product = 'ai_wallet_topup' AND topup_microfen > 0)
    );

DROP INDEX IF EXISTS public.payment_orders_one_pending_per_org;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
