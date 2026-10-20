-- +goose Up
-- declaration 197 WalletRename m20260919_000335_wallet_rename
-- source: migration/src/wallet_rename.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.user_ai_wallets RENAME TO user_wallets;
ALTER TABLE public.user_wallets
    RENAME CONSTRAINT user_ai_wallets_pkey TO user_wallets_pkey;
ALTER TABLE public.user_wallets
    RENAME CONSTRAINT user_ai_wallets_user_id_fkey TO user_wallets_user_id_fkey;
ALTER TABLE public.user_wallets
    RENAME CONSTRAINT user_ai_wallets_balance_microfen_check TO user_wallets_balance_microfen_check;
ALTER TABLE public.user_wallets
    RENAME CONSTRAINT user_ai_wallets_check TO user_wallets_check;

ALTER TABLE public.team_ai_wallet_ledger RENAME TO wallet_ledger;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_pkey TO wallet_ledger_pkey;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_key_uidx TO wallet_ledger_key_uidx;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_ai_request_id_fkey TO wallet_ledger_ai_request_id_fkey;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_org_id_fkey TO wallet_ledger_org_id_fkey;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_payment_order_id_fkey TO wallet_ledger_payment_order_id_fkey;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_user_id_fkey TO wallet_ledger_user_id_fkey;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_balance_applies TO wallet_ledger_balance_applies;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_held_applies TO wallet_ledger_held_applies;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_nonneg_after TO wallet_ledger_nonneg_after;
ALTER TABLE public.wallet_ledger
    RENAME CONSTRAINT team_ai_wallet_ledger_type_known TO wallet_ledger_type_known;

ALTER INDEX public.team_ai_wallet_ledger_org_created_idx
    RENAME TO wallet_ledger_org_created_idx;
ALTER SEQUENCE public.team_ai_wallet_ledger_id_seq RENAME TO wallet_ledger_id_seq;

CREATE OR REPLACE FUNCTION public.wallet_ledger_is_immutable()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'wallet_ledger rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER team_ai_wallet_ledger_no_rewrite ON public.wallet_ledger;
CREATE TRIGGER wallet_ledger_no_rewrite
    BEFORE UPDATE OR DELETE ON public.wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_is_immutable();
DROP FUNCTION public.team_ai_wallet_ledger_is_immutable();

ALTER TABLE public.payment_orders
    DROP CONSTRAINT payment_orders_product_known,
    DROP CONSTRAINT payment_orders_product_shape;

UPDATE public.payment_orders SET product = 'wallet_topup' WHERE product = 'ai_wallet_topup';

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_known CHECK (
        product IN ('member_seats', 'wallet_topup', 'platform_goods')),
    ADD CONSTRAINT payment_orders_product_shape CHECK (
        (product = 'member_seats' AND member_seats >= 1 AND topup_microfen IS NULL)
        OR (product = 'wallet_topup' AND topup_microfen > 0)
        OR (product = 'platform_goods' AND topup_microfen IS NULL
            AND (member_seats IS NULL OR member_seats = 0)));

UPDATE public.audit_logs SET action = 'wallet' WHERE action = 'ai_wallet';
UPDATE public.audit_logs
    SET action = 'wallet_topup_granted' WHERE action = 'ai_wallet_topup_granted';
UPDATE public.audit_logs
    SET action = 'wallet_topup_revoked' WHERE action = 'ai_wallet_topup_revoked';
UPDATE public.audit_logs
    SET action = 'wallet_topup_order_created' WHERE action = 'ai_wallet_topup_order_created';
UPDATE public.audit_logs
    SET action = 'wallet_topup_settled' WHERE action = 'ai_wallet_topup_settled';
UPDATE public.audit_logs SET entity_type = 'wallet' WHERE entity_type = 'ai_wallet';
UPDATE public.audit_logs
    SET api_path = replace(api_path, '/ai-wallet', '/wallet')
    WHERE api_path LIKE '%/ai-wallet%';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
