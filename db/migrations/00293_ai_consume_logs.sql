-- +goose Up
-- declaration 293 AiConsumeLogs
-- Post-Rust append. Does not alter 00001-00292, ai_requests, user_wallets,
-- wallet_ledger, or ai_price_schedules. quota is new-api integer quota
-- (QuotaPerUnit = 500000 per USD), not microfen. No conversion constant.
-- channel_name is a join in new-api model.Log, not a column.
-- +goose StatementBegin
CREATE TABLE public.ai_billing_ratio_documents (
    id         bigserial PRIMARY KEY,
    org_id     bigint NULL REFERENCES public.organizations(id),
    kind       text NOT NULL
        CHECK (kind IN (
            'model_ratio',
            'model_price',
            'completion_ratio',
            'cache_ratio',
            'create_cache_ratio',
            'group_ratio',
            'image_ratio',
            'audio_ratio',
            'audio_completion_ratio',
            'billing_expr'
        )),
    document   jsonb NOT NULL
        CHECK (jsonb_typeof(document) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX ai_billing_ratio_documents_platform_kind_idx
    ON public.ai_billing_ratio_documents (kind)
    WHERE org_id IS NULL;

CREATE UNIQUE INDEX ai_billing_ratio_documents_org_kind_idx
    ON public.ai_billing_ratio_documents (org_id, kind)
    WHERE org_id IS NOT NULL;

-- 00191 default privileges grant SELECT/INSERT/UPDATE/DELETE to both roles.
REVOKE ALL ON TABLE public.ai_billing_ratio_documents FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT ON TABLE public.ai_billing_ratio_documents TO podhub_app;
REVOKE ALL ON SEQUENCE public.ai_billing_ratio_documents_id_seq FROM PUBLIC, podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.ai_billing_ratio_documents_id_seq TO podhub_app;

ALTER TABLE public.ai_billing_ratio_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_billing_ratio_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.ai_billing_ratio_documents
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

CREATE TABLE public.ai_consume_logs (
    id                   bigserial PRIMARY KEY,
    org_id               bigint NOT NULL REFERENCES public.organizations(id),
    ai_request_id        bigint NULL REFERENCES public.ai_requests(id),
    user_id              bigint NOT NULL REFERENCES public.account_users(id),
    created_at           bigint NOT NULL,
    type                 integer NOT NULL CHECK (type BETWEEN 0 AND 7),
    content              text NOT NULL DEFAULT '',
    username             text NOT NULL DEFAULT '',
    token_name           text NOT NULL DEFAULT '',
    model_name           text NOT NULL DEFAULT '',
    quota                bigint NOT NULL DEFAULT 0,
    prompt_tokens        integer NOT NULL DEFAULT 0,
    completion_tokens    integer NOT NULL DEFAULT 0,
    use_time             integer NOT NULL DEFAULT 0,
    is_stream            boolean NOT NULL DEFAULT false,
    channel              integer NOT NULL DEFAULT 0,
    token_id             bigint NOT NULL DEFAULT 0,
    "group"              text NOT NULL DEFAULT '',
    ip                   text NOT NULL DEFAULT '',
    request_id           varchar(64) NOT NULL DEFAULT '',
    upstream_request_id  varchar(128) NOT NULL DEFAULT '',
    other                jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ai_consume_logs_org_created_idx
    ON public.ai_consume_logs (org_id, created_at DESC);
CREATE INDEX ai_consume_logs_org_request_idx
    ON public.ai_consume_logs (org_id, request_id);
CREATE INDEX ai_consume_logs_org_model_created_idx
    ON public.ai_consume_logs (org_id, model_name, created_at);

REVOKE ALL ON TABLE public.ai_consume_logs FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT ON TABLE public.ai_consume_logs TO podhub_app;
REVOKE ALL ON SEQUENCE public.ai_consume_logs_id_seq FROM PUBLIC, podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.ai_consume_logs_id_seq TO podhub_app;

ALTER TABLE public.ai_consume_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_consume_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.ai_consume_logs
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
