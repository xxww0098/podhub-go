-- +goose Up
-- The AI wallet belongs to a workspace, not to its owner. user_wallets (one row
-- per owner, shared by all of that owner's workspaces) becomes
-- workspace_wallets (one row per organization).
--
-- Existing money is split by the ledger: each organization keeps the hold it
-- has in flight (sum of its own held_delta), and the owner's free balance
-- moves to the owner's oldest live workspace. A synthetic, immutable
-- 'adjustment' ledger row per organization makes the per-org ledger sums equal
-- the new wallet rows, so the invariant "wallet == sum(ledger)" holds per org.

-- +goose StatementBegin
ALTER TABLE public.user_wallets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger NO FORCE ROW LEVEL SECURITY;

CREATE TABLE public.workspace_wallets (
    org_id bigint NOT NULL,
    balance_microfen bigint DEFAULT 0 NOT NULL,
    held_microfen bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_wallets_pkey PRIMARY KEY (org_id),
    CONSTRAINT workspace_wallets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
    CONSTRAINT workspace_wallets_balance_microfen_check CHECK (balance_microfen >= 0),
    CONSTRAINT workspace_wallets_check CHECK (held_microfen >= 0 AND held_microfen <= balance_microfen)
);

INSERT INTO public.workspace_wallets (org_id, balance_microfen, held_microfen)
WITH org_ledger AS (
    SELECT org_id, COALESCE(SUM(held_delta_microfen), 0)::bigint AS held
      FROM public.wallet_ledger
     GROUP BY org_id
), owned AS (
    SELECT o.id AS org_id,
           o.owner_user_id,
           COALESCE(l.held, 0) AS held,
           row_number() OVER (PARTITION BY o.owner_user_id
                              ORDER BY (o.dissolved_at IS NOT NULL), o.created_at, o.id) AS rn,
           SUM(COALESCE(l.held, 0)) OVER (PARTITION BY o.owner_user_id) AS owner_held
      FROM public.organizations o
      LEFT JOIN org_ledger l ON l.org_id = o.id
)
SELECT d.org_id,
       d.held + CASE WHEN d.rn = 1 THEN GREATEST(w.balance_microfen - d.owner_held, 0) ELSE 0 END,
       d.held
  FROM owned d
  JOIN public.user_wallets w ON w.user_id = d.owner_user_id
 WHERE d.held > 0 OR (d.rn = 1 AND w.balance_microfen > 0);

INSERT INTO public.wallet_ledger
    (org_id, user_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
     balance_before_microfen, balance_after_microfen, held_before_microfen, held_after_microfen, note)
WITH org_ledger AS (
    SELECT org_id,
           COALESCE(SUM(amount_microfen), 0)::bigint AS amount,
           COALESCE(SUM(held_delta_microfen), 0)::bigint AS held
      FROM public.wallet_ledger
     GROUP BY org_id
)
SELECT l.org_id,
       o.owner_user_id,
       'adjustment',
       'wallet-split:' || l.org_id,
       COALESCE(w.balance_microfen, 0) - l.amount,
       COALESCE(w.held_microfen, 0) - l.held,
       l.amount,
       COALESCE(w.balance_microfen, 0),
       l.held,
       COALESCE(w.held_microfen, 0),
       '工作空间钱包拆分'
  FROM org_ledger l
  JOIN public.organizations o ON o.id = l.org_id
  LEFT JOIN public.workspace_wallets w ON w.org_id = l.org_id
 WHERE COALESCE(w.balance_microfen, 0) <> l.amount
    OR COALESCE(w.held_microfen, 0) <> l.held;

DROP POLICY wallet_ledger_insert_isolation ON public.wallet_ledger;
DROP POLICY wallet_ledger_user_isolation ON public.wallet_ledger;
DROP INDEX public.wallet_ledger_user_type_idx;
ALTER TABLE public.wallet_ledger DROP COLUMN user_id;
CREATE INDEX wallet_ledger_org_type_idx ON public.wallet_ledger USING btree (org_id, entry_type);

CREATE POLICY wallet_ledger_org_select ON public.wallet_ledger FOR SELECT TO podhub_app
    USING (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint);
CREATE POLICY wallet_ledger_org_insert ON public.wallet_ledger FOR INSERT TO podhub_app
    WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint);
ALTER TABLE public.wallet_ledger FORCE ROW LEVEL SECURITY;

ALTER TABLE public.workspace_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_wallet_isolation ON public.workspace_wallets TO podhub_app
    USING (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)
    WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint);
GRANT SELECT, INSERT, UPDATE ON TABLE public.workspace_wallets TO podhub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workspace_wallets TO podhub_worker;

DROP TABLE public.user_wallets;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE TABLE public.user_wallets (
    user_id bigint NOT NULL,
    balance_microfen bigint DEFAULT 0 NOT NULL,
    held_microfen bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT user_wallets_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id),
    CONSTRAINT user_wallets_balance_microfen_check CHECK (balance_microfen >= 0),
    CONSTRAINT user_wallets_check CHECK (held_microfen >= 0 AND held_microfen <= balance_microfen)
);
ALTER TABLE public.workspace_wallets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger NO FORCE ROW LEVEL SECURITY;

INSERT INTO public.user_wallets (user_id, balance_microfen, held_microfen)
SELECT o.owner_user_id, SUM(w.balance_microfen), SUM(w.held_microfen)
  FROM public.workspace_wallets w
  JOIN public.organizations o ON o.id = w.org_id
 GROUP BY o.owner_user_id;

DROP POLICY wallet_ledger_org_select ON public.wallet_ledger;
DROP POLICY wallet_ledger_org_insert ON public.wallet_ledger;
DROP INDEX public.wallet_ledger_org_type_idx;
ALTER TABLE public.wallet_ledger ADD COLUMN user_id bigint;
ALTER TABLE public.wallet_ledger DISABLE TRIGGER wallet_ledger_no_rewrite;
UPDATE public.wallet_ledger l SET user_id = o.owner_user_id FROM public.organizations o WHERE o.id = l.org_id;
ALTER TABLE public.wallet_ledger ENABLE TRIGGER wallet_ledger_no_rewrite;
ALTER TABLE public.wallet_ledger ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.wallet_ledger ADD CONSTRAINT wallet_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);
CREATE INDEX wallet_ledger_user_type_idx ON public.wallet_ledger USING btree (user_id, entry_type);
CREATE POLICY wallet_ledger_insert_isolation ON public.wallet_ledger FOR INSERT TO podhub_app
    WITH CHECK (user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint
                AND org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint);
CREATE POLICY wallet_ledger_user_isolation ON public.wallet_ledger FOR SELECT TO podhub_app
    USING (user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint);
ALTER TABLE public.wallet_ledger FORCE ROW LEVEL SECURITY;

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY wallet_user_isolation ON public.user_wallets TO podhub_app
    USING (user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint)
    WITH CHECK (user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint);
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.user_wallets TO podhub_app;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.user_wallets TO podhub_worker;

DROP TABLE public.workspace_wallets;
-- +goose StatementEnd
