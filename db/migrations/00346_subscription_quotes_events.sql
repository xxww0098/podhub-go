-- +goose Up
-- +goose StatementBegin
-- Quotes fix the price for a short window; orders carry only a quote_id and
-- the server never trusts a client amount. Events are the append-only ledger
-- that makes fulfillment idempotent: one row per order.

CREATE TABLE public.subscription_quotes (
    id              uuid PRIMARY KEY,
    org_id          bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    revision        bigint NOT NULL,
    action          text NOT NULL CHECK (action IN ('subscribe', 'renew', 'change')),
    months          integer NOT NULL CHECK (months IN (1, 3, 6, 12)),
    term_start      timestamptz,
    term_end        timestamptz,
    plan_key        text NOT NULL REFERENCES public.plans (key),
    extra_stores    integer NOT NULL CHECK (extra_stores >= 0),
    extra_members   integer NOT NULL CHECK (extra_members >= 0),
    keep_store_ids  uuid[] NOT NULL DEFAULT '{}',
    keep_member_ids bigint[] NOT NULL DEFAULT '{}',
    amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
    breakdown       jsonb NOT NULL,
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    created_at      timestamptz NOT NULL
);
CREATE INDEX subscription_quotes_org_idx
    ON public.subscription_quotes (org_id, created_at DESC);

CREATE TABLE public.subscription_events (
    id           bigserial PRIMARY KEY,
    org_id       bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    order_id     bigint REFERENCES public.payment_orders (id),
    kind         text NOT NULL CHECK (kind IN (
        'subscribe', 'renew', 'change', 'schedule', 'expire', 'drain', 'drain_done', 'redeem')),
    effective_at timestamptz NOT NULL,
    plan_from    text,
    plan_to      text,
    stores_delta integer NOT NULL DEFAULT 0,
    members_delta integer NOT NULL DEFAULT 0,
    term_start   timestamptz,
    term_end     timestamptz,
    amount_cents bigint NOT NULL DEFAULT 0,
    breakdown    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL
);
-- The last line of idempotency: no replay path can push term_end twice.
CREATE UNIQUE INDEX subscription_events_order_uidx
    ON public.subscription_events (order_id)
    WHERE order_id IS NOT NULL;
CREATE INDEX subscription_events_org_idx
    ON public.subscription_events (org_id, effective_at DESC);

ALTER TABLE public.subscription_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.subscription_quotes
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE POLICY worker_claim ON public.subscription_quotes
    FOR ALL TO podhub_worker
    USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_quotes TO podhub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_quotes TO podhub_worker;

ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.subscription_events
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE POLICY worker_claim ON public.subscription_events
    FOR ALL TO podhub_worker
    USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON TABLE public.subscription_events TO podhub_app;
GRANT SELECT, INSERT ON TABLE public.subscription_events TO podhub_worker;

-- The sweep and reaper run across tenants. They read subscriptions and
-- events without setting app.current_org_id per row.
CREATE POLICY billing_lookup ON public.subscription_quotes
    FOR ALL TO podhub_billing_lookup
    USING (true) WITH CHECK (true);
CREATE POLICY billing_lookup ON public.subscription_events
    FOR ALL TO podhub_billing_lookup
    USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_quotes TO podhub_billing_lookup;
GRANT SELECT, INSERT ON TABLE public.subscription_events TO podhub_billing_lookup;

-- A quote is single use, claimed with an `UPDATE ... WHERE consumed_at IS
-- NULL` CAS. Unconsumed quotes are normal (a user re-quotes while browsing),
-- so there is no open-quote uniqueness; expired rows are swept by expiry.
CREATE INDEX subscription_quotes_expiry_idx
    ON public.subscription_quotes (expires_at)
    WHERE consumed_at IS NULL;
-- +goose StatementEnd
-- +goose Down
SELECT 1;
