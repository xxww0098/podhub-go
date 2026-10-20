-- +goose Up
-- declaration 149 UserAiWallet m20260912_000293_user_ai_wallet
-- source: migration/src/user_ai_wallet.rs @ a03d735
-- +goose StatementBegin
LOCK TABLE public.team_ai_wallets, public.team_ai_wallet_ledger IN ACCESS EXCLUSIVE MODE;

-- Old dissolution cleared the cache without recording the forfeiture. Record
-- that historical movement before aggregating; never invent new user credit.
INSERT INTO public.team_ai_wallet_ledger
    (org_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
     balance_before_microfen, balance_after_microfen, held_before_microfen,
     held_after_microfen, note)
SELECT w.org_id, 'adjustment', 'migration:workspace-dissolved',
       w.balance_microfen - l.balance, w.held_microfen - l.held,
       l.balance, w.balance_microfen, l.held, w.held_microfen,
       'Historical Workspace dissolution before user wallets'
FROM public.team_ai_wallets w
JOIN public.organizations o ON o.id = w.org_id AND o.dissolved_at IS NOT NULL
JOIN (SELECT org_id, SUM(amount_microfen)::bigint AS balance,
             SUM(held_delta_microfen)::bigint AS held
      FROM public.team_ai_wallet_ledger GROUP BY org_id) l USING (org_id)
WHERE w.balance_microfen <> l.balance OR w.held_microfen <> l.held;

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM public.team_ai_wallets w
        FULL JOIN (SELECT org_id, SUM(amount_microfen) AS balance,
                          SUM(held_delta_microfen) AS held
                   FROM public.team_ai_wallet_ledger GROUP BY org_id) l USING (org_id)
        WHERE COALESCE(w.balance_microfen, 0) <> COALESCE(l.balance, 0)
           OR COALESCE(w.held_microfen, 0) <> COALESCE(l.held, 0)
    ) THEN
        RAISE EXCEPTION 'wallet/ledger mismatch: reconcile before user wallet migration';
    END IF;
END $$;

CREATE TABLE public.user_ai_wallets (
    user_id bigint PRIMARY KEY REFERENCES public.account_users(id),
    balance_microfen bigint NOT NULL DEFAULT 0 CHECK (balance_microfen >= 0),
    held_microfen bigint NOT NULL DEFAULT 0 CHECK (held_microfen >= 0 AND held_microfen <= balance_microfen),
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.user_ai_wallets (user_id, balance_microfen, held_microfen, version, created_at, updated_at)
SELECT o.owner_user_id, SUM(w.balance_microfen)::bigint, SUM(w.held_microfen)::bigint,
       SUM(w.version)::bigint, MIN(w.created_at), MAX(w.updated_at)
FROM public.team_ai_wallets w JOIN public.organizations o ON o.id = w.org_id
GROUP BY o.owner_user_id;

ALTER TABLE public.team_ai_wallet_ledger ADD COLUMN user_id bigint REFERENCES public.account_users(id);
ALTER TABLE public.team_ai_wallet_ledger DISABLE TRIGGER team_ai_wallet_ledger_no_rewrite;
UPDATE public.team_ai_wallet_ledger l SET user_id = o.owner_user_id
FROM public.organizations o WHERE o.id = l.org_id;
ALTER TABLE public.team_ai_wallet_ledger ENABLE TRIGGER team_ai_wallet_ledger_no_rewrite;
ALTER TABLE public.team_ai_wallet_ledger ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX wallet_ledger_user_type_idx ON public.team_ai_wallet_ledger (user_id, entry_type);

ALTER TABLE public.user_ai_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ai_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY wallet_user_isolation ON public.user_ai_wallets FOR ALL TO podhub_app
    USING (user_id = NULLIF(current_setting('app.current_wallet_user_id', true), '')::bigint)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_wallet_user_id', true), '')::bigint);
DROP POLICY wallet_ledger_tenant_isolation ON public.team_ai_wallet_ledger;
CREATE POLICY wallet_ledger_user_isolation ON public.team_ai_wallet_ledger FOR SELECT TO podhub_app
    USING (user_id = NULLIF(current_setting('app.current_wallet_user_id', true), '')::bigint);
CREATE POLICY wallet_ledger_insert_isolation ON public.team_ai_wallet_ledger FOR INSERT TO podhub_app
    WITH CHECK (user_id = NULLIF(current_setting('app.current_wallet_user_id', true), '')::bigint
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
GRANT SELECT, INSERT, UPDATE ON public.user_ai_wallets TO podhub_app, podhub_worker;
DROP TABLE public.team_ai_wallets;

-- CPA has no per-Workspace external accounts or provisioning worker. Preserve
-- request charge evidence; remove only obsolete credentials and delivery work.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM public.agw_provision_outbox WHERE kind = 'credit') THEN
        RAISE EXCEPTION 'archive and reconcile external credit delivery evidence before retiring external billing';
    END IF;
END $$;
DROP TABLE public.agw_user_wallets;
DROP TABLE public.agw_provision_outbox;
DROP TABLE public.agw_accounts;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
