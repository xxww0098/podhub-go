-- sqlc snapshots for the read-only queries. Runtime DDL is the goose chain.
-- These tables only need the columns those SELECTs touch.

CREATE TABLE public.jobs (
    id uuid PRIMARY KEY,
    org_id bigint NOT NULL,
    kind text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    input_revision bigint NOT NULL,
    input_fingerprint text,
    idempotency_key text NOT NULL,
    priority smallint NOT NULL,
    state text NOT NULL,
    attempt integer NOT NULL,
    max_attempts integer NOT NULL,
    lease_owner text,
    lease_until timestamptz,
    lease_epoch bigint NOT NULL,
    cost_units integer NOT NULL,
    lane text NOT NULL,
    submitter_user_id bigint NOT NULL,
    payload jsonb NOT NULL,
    result_ref jsonb,
    cancel_requested_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE public.listing_rows (
    id uuid PRIMARY KEY,
    org_id bigint NOT NULL,
    card_id uuid NOT NULL
);

CREATE TABLE public.ai_requests (
    id bigint PRIMARY KEY,
    public_id text NOT NULL,
    org_id bigint NOT NULL,
    model text NOT NULL,
    operation text NOT NULL,
    status text NOT NULL,
    prompt_tokens bigint NOT NULL,
    cached_prompt_tokens bigint NOT NULL,
    completion_tokens bigint NOT NULL,
    reasoning_completion_tokens bigint NOT NULL,
    total_microfen bigint NOT NULL,
    charged_microfen bigint NOT NULL,
    absorbed_microfen bigint NOT NULL,
    error_class text,
    created_at timestamptz NOT NULL,
    settled_at timestamptz
);

CREATE TABLE public.billable_usage_rollups (
    id bigint PRIMARY KEY,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    billing_period text NOT NULL,
    metric text NOT NULL,
    unit text NOT NULL,
    verification text NOT NULL,
    total bigint NOT NULL
);
