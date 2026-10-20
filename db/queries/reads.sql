-- Read SQL copied from xxww0098/podhub @ a03d735.
-- jobs: src/listing/kernel/execution/jobs/mod.rs JOB_SELECT / job / list_jobs
-- banned tags: src/platform/banned_tags/store.rs
-- usage: src/telemetry/usage_store.rs and src/telemetry/store.rs

-- name: ListEnabledBannedTagRules :many
SELECT term, match_mode FROM public.banned_tags WHERE enabled ORDER BY id;

-- name: ListBannedTags :many
SELECT id, term, match_mode, note, created_by,
       created_at::text AS created_at, enabled
FROM public.banned_tags
ORDER BY id;

-- name: GetJob :one
SELECT
    id::text AS id,
    org_id,
    kind,
    aggregate_type,
    aggregate_id::text AS aggregate_id,
    input_revision,
    input_fingerprint,
    idempotency_key,
    priority,
    state,
    attempt,
    max_attempts,
    lease_owner,
    lease_until,
    lease_epoch,
    cost_units,
    lane,
    submitter_user_id,
    payload,
    result_ref,
    cancel_requested_at,
    last_error_code,
    created_at,
    updated_at
FROM jobs
WHERE org_id = $1 AND id = $2::uuid;

-- name: ListJobs :many
SELECT
    id::text AS id,
    org_id,
    kind,
    aggregate_type,
    aggregate_id::text AS aggregate_id,
    input_revision,
    input_fingerprint,
    idempotency_key,
    priority,
    state,
    attempt,
    max_attempts,
    lease_owner,
    lease_until,
    lease_epoch,
    cost_units,
    lane,
    submitter_user_id,
    payload,
    result_ref,
    cancel_requested_at,
    last_error_code,
    created_at,
    updated_at
FROM jobs
WHERE org_id = $1
ORDER BY updated_at DESC, id DESC
LIMIT $2::bigint;

-- name: ListJobsAfter :many
SELECT
    id::text AS id,
    org_id,
    kind,
    aggregate_type,
    aggregate_id::text AS aggregate_id,
    input_revision,
    input_fingerprint,
    idempotency_key,
    priority,
    state,
    attempt,
    max_attempts,
    lease_owner,
    lease_until,
    lease_epoch,
    cost_units,
    lane,
    submitter_user_id,
    payload,
    result_ref,
    cancel_requested_at,
    last_error_code,
    created_at,
    updated_at
FROM jobs
WHERE org_id = $1
  AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($2::bigint || ' microseconds')::interval), $3::uuid)
ORDER BY updated_at DESC, id DESC
LIMIT $4::bigint;

-- name: ListJobsForCard :many
SELECT
    id::text AS id,
    org_id,
    kind,
    aggregate_type,
    aggregate_id::text AS aggregate_id,
    input_revision,
    input_fingerprint,
    idempotency_key,
    priority,
    state,
    attempt,
    max_attempts,
    lease_owner,
    lease_until,
    lease_epoch,
    cost_units,
    lane,
    submitter_user_id,
    payload,
    result_ref,
    cancel_requested_at,
    last_error_code,
    created_at,
    updated_at
FROM jobs
WHERE jobs.org_id = $1
  AND EXISTS (
      SELECT 1 FROM listing_rows r
      WHERE r.org_id = jobs.org_id
        AND r.id = jobs.aggregate_id
        AND r.card_id = $3::uuid
  )
ORDER BY updated_at DESC, id DESC
LIMIT $2::bigint;

-- name: ListJobsForCardAfter :many
SELECT
    id::text AS id,
    org_id,
    kind,
    aggregate_type,
    aggregate_id::text AS aggregate_id,
    input_revision,
    input_fingerprint,
    idempotency_key,
    priority,
    state,
    attempt,
    max_attempts,
    lease_owner,
    lease_until,
    lease_epoch,
    cost_units,
    lane,
    submitter_user_id,
    payload,
    result_ref,
    cancel_requested_at,
    last_error_code,
    created_at,
    updated_at
FROM jobs
WHERE jobs.org_id = $1
  AND EXISTS (
      SELECT 1 FROM listing_rows r
      WHERE r.org_id = jobs.org_id
        AND r.id = jobs.aggregate_id
        AND r.card_id = $5::uuid
  )
  AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($2::bigint || ' microseconds')::interval), $3::uuid)
ORDER BY updated_at DESC, id DESC
LIMIT $4::bigint;

-- name: SummarizeAIUsage :one
SELECT count(*)::bigint AS requests,
       COALESCE(sum(prompt_tokens), 0)::bigint AS input_tokens,
       COALESCE(sum(cached_prompt_tokens), 0)::bigint AS cached_input_tokens,
       COALESCE(sum(completion_tokens), 0)::bigint AS output_tokens,
       COALESCE(sum(charged_microfen), 0)::bigint AS charged_microfen,
       COALESCE(sum(absorbed_microfen), 0)::bigint AS absorbed_microfen
FROM ai_requests
WHERE org_id = $1
  AND created_at >= ($2::date AT TIME ZONE 'UTC')
  AND created_at < (($3::date + 1) AT TIME ZONE 'UTC');

-- name: ListAIUsageRequests :many
SELECT public_id, model, operation, status,
       prompt_tokens, cached_prompt_tokens, completion_tokens,
       reasoning_completion_tokens, total_microfen,
       charged_microfen, absorbed_microfen, error_class,
       created_at, settled_at
FROM ai_requests
WHERE org_id = $1
  AND created_at >= ($2::date AT TIME ZONE 'UTC')
  AND created_at < (($3::date + 1) AT TIME ZONE 'UTC')
ORDER BY created_at DESC, id DESC
LIMIT $4::bigint OFFSET $5::bigint;

-- name: ListBillingUsage :many
SELECT user_id, metric, unit, verification, total
FROM billable_usage_rollups
WHERE org_id = $1 AND billing_period = $2;
