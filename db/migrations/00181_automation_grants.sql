-- +goose Up
-- declaration 181 AutomationGrants m20260917_000319_automation_grants
-- source: migration/src/automation_grants.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.automation_grants (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id bigint NOT NULL,
    org_id bigint NOT NULL,
    name varchar(120) NOT NULL,
    token_hash varchar(128) NOT NULL,
    token_prefix varchar(24) NOT NULL,
    actions text[] NOT NULL,
    expires_at timestamptz,
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_grants_pkey PRIMARY KEY (id),
    CONSTRAINT automation_grants_actions_known
        CHECK (cardinality(actions) > 0 AND actions <@ ARRAY['read','prepare','submit']::text[])
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_grants_token_hash_uidx
    ON public.automation_grants (token_hash);
CREATE INDEX IF NOT EXISTS automation_grants_user_idx
    ON public.automation_grants (user_id, org_id)
    WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.automation_grants TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
