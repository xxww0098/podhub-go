-- +goose Up
-- declaration 48 AiWallet m20260819_000212_ai_wallet
-- source: migration/src/ai_wallet.rs @ a03d735
-- +goose StatementBegin
DO $$
BEGIN

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_app')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_app') THEN
            ALTER ROLE ozon_pod_app RENAME TO podhub_app;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_app')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_app') THEN
            ALTER ROLE podx_app RENAME TO podhub_app;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_app NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_worker') THEN
            ALTER ROLE ozon_pod_worker RENAME TO podhub_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_worker') THEN
            ALTER ROLE podx_worker RENAME TO podhub_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_worker NOINHERIT BYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
END
$$;

-- Migrator / runtime login role must be able to assume both, already at this
-- first role-creating migration and not only once the later Listing SaaS
-- migration runs.
GRANT podhub_app TO CURRENT_USER;
GRANT podhub_worker TO CURRENT_USER;

CREATE TABLE public.team_ai_wallets (
    org_id            bigint PRIMARY KEY REFERENCES public.organizations(id),
    balance_microfen  bigint NOT NULL DEFAULT 0,
    held_microfen     bigint NOT NULL DEFAULT 0,
    version           bigint NOT NULL DEFAULT 0,
    created_at        timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT team_ai_wallets_balance_nonneg CHECK (balance_microfen >= 0),
    CONSTRAINT team_ai_wallets_held_nonneg CHECK (held_microfen >= 0),
    CONSTRAINT team_ai_wallets_held_within_balance CHECK (held_microfen <= balance_microfen)
);

CREATE TABLE public.ai_price_schedules (
    id                            bigserial PRIMARY KEY,
    model                         character varying(128) NOT NULL,
    version                       integer NOT NULL,
    input_fen_per_million         bigint NOT NULL,
    cached_input_fen_per_million  bigint NOT NULL,
    output_fen_per_million        bigint NOT NULL,
    reasoning_fen_per_million     bigint NOT NULL,
    max_request_microfen          bigint NOT NULL,
    effective_from                timestamp with time zone NOT NULL,
    effective_to                  timestamp with time zone,
    created_by_user_id            bigint REFERENCES public.account_users(id),
    created_at                    timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ai_price_schedules_model_version_key UNIQUE (model, version),
    CONSTRAINT ai_price_schedules_version_positive CHECK (version >= 1),
    CONSTRAINT ai_price_schedules_rates_nonneg CHECK (
        input_fen_per_million >= 0
        AND cached_input_fen_per_million >= 0
        AND output_fen_per_million >= 0
        AND reasoning_fen_per_million >= 0
    ),
    CONSTRAINT ai_price_schedules_hold_positive CHECK (max_request_microfen > 0),
    CONSTRAINT ai_price_schedules_window_ordered CHECK (
        effective_to IS NULL OR effective_to > effective_from
    )
);

CREATE INDEX ai_price_schedules_model_effective_idx
    ON public.ai_price_schedules (model, effective_from DESC);

CREATE TABLE public.ai_requests (
    id                            bigserial PRIMARY KEY,
    public_id                     character varying(64) NOT NULL,
    org_id                        bigint NOT NULL REFERENCES public.organizations(id),
    user_id                       bigint NOT NULL REFERENCES public.account_users(id),
    idempotency_key               character varying(128) NOT NULL,
    model                         character varying(128) NOT NULL,
    upstream_account_id           character varying(64) NOT NULL,
    status                        character varying(32) NOT NULL,
    price_schedule_id             bigint NOT NULL REFERENCES public.ai_price_schedules(id),
    price_version                 integer NOT NULL,
    input_fen_per_million         bigint NOT NULL,
    cached_input_fen_per_million  bigint NOT NULL,
    output_fen_per_million        bigint NOT NULL,
    reasoning_fen_per_million     bigint NOT NULL,
    held_microfen                 bigint NOT NULL,
    prompt_tokens                 bigint NOT NULL DEFAULT 0,
    cached_prompt_tokens          bigint NOT NULL DEFAULT 0,
    completion_tokens             bigint NOT NULL DEFAULT 0,
    reasoning_completion_tokens   bigint NOT NULL DEFAULT 0,
    uncached_input_microfen       bigint NOT NULL DEFAULT 0,
    cached_input_microfen         bigint NOT NULL DEFAULT 0,
    output_microfen               bigint NOT NULL DEFAULT 0,
    reasoning_microfen            bigint NOT NULL DEFAULT 0,
    total_microfen                bigint NOT NULL DEFAULT 0,
    upstream_response_id          character varying(128),
    error_class                   character varying(48),
    response_body                 jsonb,
    created_at                    timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    dispatched_at                 timestamp with time zone,
    settled_at                    timestamp with time zone,
    updated_at                    timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ai_requests_public_id_key UNIQUE (public_id),
    CONSTRAINT ai_requests_org_idempotency_key UNIQUE (org_id, idempotency_key),
    CONSTRAINT ai_requests_status_known CHECK (
        status IN ('held', 'dispatching', 'settled', 'failed', 'unbilled_unknown')
    ),
    CONSTRAINT ai_requests_hold_positive CHECK (held_microfen > 0),
    CONSTRAINT ai_requests_tokens_nonneg CHECK (
        prompt_tokens >= 0 AND completion_tokens >= 0
        AND cached_prompt_tokens >= 0 AND reasoning_completion_tokens >= 0
    ),
    CONSTRAINT ai_requests_token_details_within_totals CHECK (
        cached_prompt_tokens <= prompt_tokens
        AND reasoning_completion_tokens <= completion_tokens
    ),
    CONSTRAINT ai_requests_charges_nonneg CHECK (
        uncached_input_microfen >= 0 AND cached_input_microfen >= 0
        AND output_microfen >= 0 AND reasoning_microfen >= 0
        AND total_microfen >= 0
    ),
    CONSTRAINT ai_requests_total_is_sum CHECK (
        total_microfen = uncached_input_microfen + cached_input_microfen
                       + output_microfen + reasoning_microfen
    )
);

CREATE INDEX ai_requests_org_created_idx
    ON public.ai_requests (org_id, created_at DESC);

CREATE TABLE public.team_ai_wallet_ledger (
    id                       bigserial PRIMARY KEY,
    org_id                   bigint NOT NULL REFERENCES public.organizations(id),
    entry_type               character varying(32) NOT NULL,
    idempotency_key          character varying(128) NOT NULL,
    amount_microfen          bigint NOT NULL,
    held_delta_microfen      bigint NOT NULL,
    balance_before_microfen  bigint NOT NULL,
    balance_after_microfen   bigint NOT NULL,
    held_before_microfen     bigint NOT NULL,
    held_after_microfen      bigint NOT NULL,
    ai_request_id            bigint REFERENCES public.ai_requests(id),
    payment_order_id         bigint REFERENCES public.payment_orders(id),
    note                     text NOT NULL DEFAULT '',
    created_at               timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT team_ai_wallet_ledger_type_known CHECK (
        entry_type IN ('topup', 'hold', 'settle', 'release', 'refund', 'adjustment')
    ),
    CONSTRAINT team_ai_wallet_ledger_key_uidx UNIQUE (org_id, entry_type, idempotency_key),
    CONSTRAINT team_ai_wallet_ledger_balance_applies CHECK (
        balance_after_microfen = balance_before_microfen + amount_microfen
    ),
    CONSTRAINT team_ai_wallet_ledger_held_applies CHECK (
        held_after_microfen = held_before_microfen + held_delta_microfen
    ),
    CONSTRAINT team_ai_wallet_ledger_nonneg_after CHECK (
        balance_after_microfen >= 0 AND held_after_microfen >= 0
    )
);

CREATE INDEX team_ai_wallet_ledger_org_created_idx
    ON public.team_ai_wallet_ledger (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.team_ai_wallet_ledger_is_immutable()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'team_ai_wallet_ledger rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER team_ai_wallet_ledger_no_rewrite
    BEFORE UPDATE OR DELETE ON public.team_ai_wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION public.team_ai_wallet_ledger_is_immutable();

ALTER TABLE public.team_ai_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_ai_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY wallet_tenant_isolation ON public.team_ai_wallets
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
ALTER TABLE public.team_ai_wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_ai_wallet_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY wallet_ledger_tenant_isolation ON public.team_ai_wallet_ledger
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
GRANT SELECT, INSERT, UPDATE ON TABLE public.team_ai_wallets TO podhub_app, podhub_worker;
GRANT SELECT, INSERT ON TABLE public.team_ai_wallet_ledger TO podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.team_ai_wallet_ledger_id_seq TO podhub_app, podhub_worker;

ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS product character varying(32) NOT NULL DEFAULT 'team_plan',
    ADD COLUMN IF NOT EXISTS topup_microfen bigint;

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_known
        CHECK (product IN ('team_plan', 'ai_wallet_topup'));

CREATE UNIQUE INDEX payment_orders_one_pending_per_org_product
    ON public.payment_orders (org_id, product)
    WHERE status = 'pending';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
