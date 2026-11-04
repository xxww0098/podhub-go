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
    jobs.id::text AS id,
    jobs.org_id,
    jobs.kind,
    jobs.aggregate_type,
    jobs.aggregate_id::text AS aggregate_id,
    jobs.input_revision,
    jobs.input_fingerprint,
    jobs.idempotency_key,
    jobs.priority,
    jobs.state,
    jobs.attempt,
    jobs.max_attempts,
    jobs.lease_owner,
    jobs.lease_until,
    jobs.lease_epoch,
    jobs.cost_units,
    jobs.lane,
    jobs.submitter_user_id,
    jobs.payload,
    jobs.result_ref,
    jobs.cancel_requested_at,
    jobs.last_error_code,
    jobs.created_at,
    jobs.updated_at
FROM jobs
WHERE jobs.org_id = $1 AND jobs.id = $2::uuid
  AND (
    $3::boolean
    OR submitter_user_id = $4
    OR EXISTS (
        SELECT 1 FROM listing_rows r
        LEFT JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
        WHERE r.org_id = jobs.org_id AND r.id = jobs.aggregate_id
          AND (COALESCE(r.store_id, c.store_id) IS NULL
               OR COALESCE(r.store_id, c.store_id) = ANY($5::uuid[]))
    )
  );

-- name: ListJobs :many
SELECT
    jobs.id::text AS id,
    jobs.org_id,
    jobs.kind,
    jobs.aggregate_type,
    jobs.aggregate_id::text AS aggregate_id,
    jobs.input_revision,
    jobs.input_fingerprint,
    jobs.idempotency_key,
    jobs.priority,
    jobs.state,
    jobs.attempt,
    jobs.max_attempts,
    jobs.lease_owner,
    jobs.lease_until,
    jobs.lease_epoch,
    jobs.cost_units,
    jobs.lane,
    jobs.submitter_user_id,
    jobs.payload,
    jobs.result_ref,
    jobs.cancel_requested_at,
    jobs.last_error_code,
    jobs.created_at,
    jobs.updated_at
FROM jobs
WHERE jobs.org_id = $1
  AND (
    $3::boolean
    OR submitter_user_id = $4
    OR EXISTS (
        SELECT 1 FROM listing_rows r
        LEFT JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
        WHERE r.org_id = jobs.org_id AND r.id = jobs.aggregate_id
          AND (COALESCE(r.store_id, c.store_id) IS NULL
               OR COALESCE(r.store_id, c.store_id) = ANY($5::uuid[]))
    )
  )
ORDER BY jobs.updated_at DESC, jobs.id DESC
LIMIT $2::bigint;

-- name: ListJobsAfter :many
SELECT
    jobs.id::text AS id,
    jobs.org_id,
    jobs.kind,
    jobs.aggregate_type,
    jobs.aggregate_id::text AS aggregate_id,
    jobs.input_revision,
    jobs.input_fingerprint,
    jobs.idempotency_key,
    jobs.priority,
    jobs.state,
    jobs.attempt,
    jobs.max_attempts,
    jobs.lease_owner,
    jobs.lease_until,
    jobs.lease_epoch,
    jobs.cost_units,
    jobs.lane,
    jobs.submitter_user_id,
    jobs.payload,
    jobs.result_ref,
    jobs.cancel_requested_at,
    jobs.last_error_code,
    jobs.created_at,
    jobs.updated_at
FROM jobs
WHERE jobs.org_id = $1
  AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($2::bigint || ' microseconds')::interval), $3::uuid)
  AND (
    $5::boolean
    OR submitter_user_id = $6
    OR EXISTS (
        SELECT 1 FROM listing_rows r
        LEFT JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
        WHERE r.org_id = jobs.org_id AND r.id = jobs.aggregate_id
          AND (COALESCE(r.store_id, c.store_id) IS NULL
               OR COALESCE(r.store_id, c.store_id) = ANY($7::uuid[]))
    )
  )
ORDER BY jobs.updated_at DESC, jobs.id DESC
LIMIT $4::bigint;

-- name: ListJobsForCard :many
SELECT
    jobs.id::text AS id,
    jobs.org_id,
    jobs.kind,
    jobs.aggregate_type,
    jobs.aggregate_id::text AS aggregate_id,
    jobs.input_revision,
    jobs.input_fingerprint,
    jobs.idempotency_key,
    jobs.priority,
    jobs.state,
    jobs.attempt,
    jobs.max_attempts,
    jobs.lease_owner,
    jobs.lease_until,
    jobs.lease_epoch,
    jobs.cost_units,
    jobs.lane,
    jobs.submitter_user_id,
    jobs.payload,
    jobs.result_ref,
    jobs.cancel_requested_at,
    jobs.last_error_code,
    jobs.created_at,
    jobs.updated_at
FROM jobs
WHERE jobs.org_id = $1
  AND EXISTS (
      SELECT 1 FROM listing_rows r
      WHERE r.org_id = jobs.org_id
        AND r.id = jobs.aggregate_id
        AND r.card_id = $3::uuid
  )
  AND (
    $4::boolean
    OR submitter_user_id = $5
    OR EXISTS (
        SELECT 1 FROM listing_rows r
        LEFT JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
        WHERE r.org_id = jobs.org_id AND r.id = jobs.aggregate_id
          AND (COALESCE(r.store_id, c.store_id) IS NULL
               OR COALESCE(r.store_id, c.store_id) = ANY($6::uuid[]))
    )
  )
ORDER BY jobs.updated_at DESC, jobs.id DESC
LIMIT $2::bigint;

-- name: ListJobsForCardAfter :many
SELECT
    jobs.id::text AS id,
    jobs.org_id,
    jobs.kind,
    jobs.aggregate_type,
    jobs.aggregate_id::text AS aggregate_id,
    jobs.input_revision,
    jobs.input_fingerprint,
    jobs.idempotency_key,
    jobs.priority,
    jobs.state,
    jobs.attempt,
    jobs.max_attempts,
    jobs.lease_owner,
    jobs.lease_until,
    jobs.lease_epoch,
    jobs.cost_units,
    jobs.lane,
    jobs.submitter_user_id,
    jobs.payload,
    jobs.result_ref,
    jobs.cancel_requested_at,
    jobs.last_error_code,
    jobs.created_at,
    jobs.updated_at
FROM jobs
WHERE jobs.org_id = $1
  AND EXISTS (
      SELECT 1 FROM listing_rows r
      WHERE r.org_id = jobs.org_id
        AND r.id = jobs.aggregate_id
        AND r.card_id = $5::uuid
  )
  AND (updated_at, id) < ((TIMESTAMPTZ 'epoch' + ($2::bigint || ' microseconds')::interval), $3::uuid)
  AND (
    $6::boolean
    OR submitter_user_id = $7
    OR EXISTS (
        SELECT 1 FROM listing_rows r
        LEFT JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
        WHERE r.org_id = jobs.org_id AND r.id = jobs.aggregate_id
          AND (COALESCE(r.store_id, c.store_id) IS NULL
               OR COALESCE(r.store_id, c.store_id) = ANY($8::uuid[]))
    )
  )
ORDER BY jobs.updated_at DESC, jobs.id DESC
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
