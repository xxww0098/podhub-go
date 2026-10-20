-- +goose Up
-- declaration 258 DelegateSettlement m20260930_000441_delegate_settlement
-- source: migration/src/delegate_settlement.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.delegate_dispatches
    ADD COLUMN nudge_count integer NOT NULL DEFAULT 0,
    ADD COLUMN nudged_at_ms bigint;

ALTER TABLE public.delegate_dispatches
    DROP CONSTRAINT IF EXISTS ck_delegate_dispatches_nudge_nonneg;
ALTER TABLE public.delegate_dispatches
    ADD CONSTRAINT ck_delegate_dispatches_nudge_nonneg
        CHECK (nudge_count >= 0);

CREATE TABLE public.delegate_settlements (
    settlement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations (id),
    order_id uuid NOT NULL REFERENCES public.delegate_orders (order_id),
    dispatch_id uuid NOT NULL REFERENCES public.delegate_dispatches (dispatch_id),
    source_id text NOT NULL REFERENCES public.sc_sources (source_id),
    amount_cents bigint NOT NULL,
    amount_microfen bigint NOT NULL,
    state text NOT NULL,
    breakdown jsonb NOT NULL,
    held_at_ms bigint NOT NULL,
    settled_at_ms bigint,
    released_at_ms bigint,
    CONSTRAINT ux_delegate_settlements_dispatch UNIQUE (dispatch_id),
    CONSTRAINT ck_delegate_settlements_state
        CHECK (state IN ('held', 'settled', 'released')),
    CONSTRAINT ck_delegate_settlements_amount
        CHECK (amount_cents > 0 AND amount_microfen = amount_cents * 1000000)
);

CREATE INDEX ix_delegate_settlements_order
    ON public.delegate_settlements (order_id, state);

CREATE TABLE public.supplier_wallets (
    source_id text PRIMARY KEY REFERENCES public.sc_sources (source_id),
    balance_microfen bigint NOT NULL DEFAULT 0,
    held_microfen bigint NOT NULL DEFAULT 0,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ck_supplier_wallets_balance CHECK (balance_microfen >= 0),
    CONSTRAINT ck_supplier_wallets_held CHECK (held_microfen >= 0),
    CONSTRAINT ck_supplier_wallets_held_within CHECK (held_microfen <= balance_microfen)
);

CREATE TABLE public.supplier_wallet_ledger (
    ledger_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id text NOT NULL REFERENCES public.sc_sources (source_id),
    entry_type text NOT NULL,
    idempotency_key text NOT NULL,
    amount_microfen bigint NOT NULL,
    held_delta_microfen bigint NOT NULL,
    balance_after_microfen bigint NOT NULL,
    held_after_microfen bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT ck_supplier_wallet_ledger_type CHECK (
        entry_type IN ('credit', 'withdrawal_hold', 'withdrawal_paid', 'withdrawal_release')
    ),
    CONSTRAINT ux_supplier_wallet_ledger_key
        UNIQUE (source_id, entry_type, idempotency_key)
);

CREATE TABLE public.supplier_withdrawals (
    withdrawal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id text NOT NULL REFERENCES public.sc_sources (source_id),
    amount_cents bigint NOT NULL,
    amount_microfen bigint NOT NULL,
    channel text NOT NULL,
    account text NOT NULL,
    real_name text NOT NULL,
    status text NOT NULL,
    reference text,
    reject_reason text,
    requested_at_ms bigint NOT NULL,
    decided_at_ms bigint,
    CONSTRAINT ck_supplier_withdrawals_status
        CHECK (status IN ('requested', 'paid', 'rejected')),
    CONSTRAINT ck_supplier_withdrawals_amount
        CHECK (amount_cents > 0 AND amount_microfen = amount_cents * 1000000),
    CONSTRAINT ck_supplier_withdrawals_channel
        CHECK (channel IN ('alipay', 'wechat', 'bank'))
);

CREATE INDEX ix_supplier_withdrawals_source_status
    ON public.supplier_withdrawals (source_id, status, requested_at_ms DESC);

CREATE UNIQUE INDEX ux_supplier_withdrawals_one_open
    ON public.supplier_withdrawals (source_id)
    WHERE status = 'requested';

ALTER TABLE public.delegate_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY delegate_org_isolation ON public.delegate_settlements
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE POLICY delegate_staff_isolation ON public.delegate_settlements
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');
CREATE POLICY delegate_source_isolation ON public.delegate_settlements
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = delegate_settlements.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = delegate_settlements.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

ALTER TABLE public.supplier_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_source_isolation ON public.supplier_wallets
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = supplier_wallets.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = supplier_wallets.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ));
CREATE POLICY supplier_staff_isolation ON public.supplier_wallets
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.supplier_wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_wallet_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_source_isolation ON public.supplier_wallet_ledger
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = supplier_wallet_ledger.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = supplier_wallet_ledger.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ));
CREATE POLICY supplier_staff_isolation ON public.supplier_wallet_ledger
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.supplier_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_source_isolation ON public.supplier_withdrawals
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = supplier_withdrawals.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = supplier_withdrawals.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ));
CREATE POLICY supplier_staff_isolation ON public.supplier_withdrawals
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.delegate_settlements,
    public.supplier_wallets,
    public.supplier_withdrawals
TO podhub_app, podhub_worker;

-- The ledger is append-only: no UPDATE or DELETE for the application roles.
GRANT SELECT, INSERT ON TABLE public.supplier_wallet_ledger
TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
