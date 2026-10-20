package automationrepo

// SQL text follows spec-aomt-automation.md. Parameter numbers match that text.
const (
	sqlListAssets = `
SELECT s.id::text, s.name, s.created_at,
       i.id::text, i.file_name, i.sha256, i.size_bytes, i.runtime_id::text
  FROM automation_asset_sets s
  LEFT JOIN automation_asset_set_items i ON i.set_id = s.id
 WHERE s.org_id = $1 AND s.user_id = $2
 ORDER BY s.created_at DESC, s.id, i.created_at, i.id`

	sqlInsertSet = `
INSERT INTO automation_asset_sets (org_id, user_id, name)
VALUES ($1, $2, $3)
RETURNING id::text, name, created_at`

	sqlInsertItem = `
INSERT INTO automation_asset_set_items
     (set_id, item_kind, item_key, file_name, sha256, size_bytes, runtime_id)
VALUES ($1::uuid, 'local_file', $2, $3, $4, $5,
        (SELECT id FROM automation_runtimes
          WHERE id = $6::uuid AND org_id = $7 AND user_id = $8
            AND deregistered_at IS NULL))
ON CONFLICT (set_id, item_key) DO UPDATE
   SET runtime_id = EXCLUDED.runtime_id,
       size_bytes = EXCLUDED.size_bytes
RETURNING id::text, file_name, sha256, size_bytes, runtime_id::text`

	sqlClaim = `
WITH rt AS (
    SELECT id, grant_id, org_id, user_id, label FROM automation_runtimes
     WHERE id = $3::uuid AND org_id = $1 AND user_id = $2
       AND deregistered_at IS NULL
),
due AS (
    SELECT c.id
      FROM browser_commands c
      JOIN rt ON c.grant_id = rt.grant_id
      JOIN automation_grants g ON g.id = c.grant_id
     WHERE c.org_id = $1
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
       AND (c.status = 'queued'
            OR (c.status = 'claimed'
                AND c.claim_expires_at < clock_timestamp()))
       AND (c.action <> 'assets_import'
            OR NOT EXISTS (
                SELECT 1
                  FROM automation_asset_set_items i
                  JOIN automation_runtimes holder ON holder.id = i.runtime_id
                 WHERE i.set_id = (
                           CASE
                             WHEN c.payload->>'assetSetId'
                                  ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                             THEN (c.payload->>'assetSetId')::uuid
                           END)
                   AND holder.id <> rt.id
                   AND NOT (
                       holder.org_id = rt.org_id
                       AND holder.user_id = rt.user_id
                       AND holder.label = rt.label
                       AND holder.label ~ '^tab [0-9]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                   AND holder.deregistered_at IS NULL
                   AND holder.heartbeat_at > clock_timestamp() - interval '45 seconds'))
     ORDER BY c.created_at
     LIMIT $4
     FOR UPDATE OF c SKIP LOCKED
)
UPDATE browser_commands c
   SET status = 'claimed', claimed_by = rt.id,
       claim_epoch = c.claim_epoch + 1,
       claim_expires_at = clock_timestamp() + interval '90 seconds',
       updated_at = clock_timestamp()
  FROM rt
 WHERE c.id IN (SELECT id FROM due)
 RETURNING c.id::text, c.client_request_id, c.action, c.payload, c.status, c.claim_epoch,
           c.progress, c.result, c.error, c.cancel_requested_at, c.created_at, c.updated_at`

	sqlTouchHeartbeat = `
UPDATE automation_runtimes SET heartbeat_at = clock_timestamp()
 WHERE id = $3::uuid AND org_id = $1 AND user_id = $2 AND deregistered_at IS NULL`

	sqlRenew = `
UPDATE browser_commands c
   SET claim_expires_at = clock_timestamp() + interval '90 seconds',
       updated_at = clock_timestamp()
  FROM automation_runtimes rt
 WHERE c.id = $3::uuid AND c.org_id = $1
   AND c.status = 'claimed'
   AND c.claimed_by = rt.id
   AND rt.id = $5::uuid
   AND rt.user_id = $2 AND rt.deregistered_at IS NULL
   AND c.claim_epoch = $4
   AND c.claim_expires_at > clock_timestamp()
   AND EXISTS (
       SELECT 1 FROM automation_grants g
        WHERE g.id = c.grant_id AND g.org_id = c.org_id
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp()))
RETURNING (c.cancel_requested_at IS NOT NULL)`

	sqlProgress = `
UPDATE browser_commands c
   SET progress = $4::jsonb, updated_at = clock_timestamp()
  FROM automation_runtimes rt
 WHERE c.id = $3::uuid AND c.org_id = $1
   AND c.status = 'claimed'
   AND c.claimed_by = rt.id
   AND rt.user_id = $2 AND rt.deregistered_at IS NULL
   AND c.claim_epoch = $5
   AND c.claim_expires_at > clock_timestamp()
RETURNING c.id::text, c.client_request_id, c.action, c.payload, c.status, c.claim_epoch,
          c.progress, c.result, c.error, c.cancel_requested_at, c.created_at, c.updated_at`

	sqlSettle = `
UPDATE browser_commands c
   SET status = $4, result = $5::jsonb, error = $6::jsonb,
       claim_expires_at = NULL, updated_at = clock_timestamp()
  FROM automation_runtimes rt
 WHERE c.id = $3::uuid AND c.org_id = $1
   AND c.status = 'claimed'
   AND c.claimed_by = rt.id
   AND rt.user_id = $2 AND rt.deregistered_at IS NULL
   AND c.claim_epoch = $7
   AND c.claim_expires_at > clock_timestamp()
RETURNING c.id::text, c.client_request_id, c.action, c.payload, c.status, c.claim_epoch,
          c.progress, c.result, c.error, c.cancel_requested_at, c.created_at, c.updated_at`

	sqlCommandExists = `
SELECT 1 FROM browser_commands WHERE org_id = $1 AND id = $2::uuid`

	sqlListGrants = `
SELECT id::text, name, token_prefix, actions, expires_at, revoked_at, last_used_at, created_at
  FROM automation_grants
 WHERE user_id=$1 AND scope_kind=$2 AND org_id IS NOT DISTINCT FROM $3::bigint
 ORDER BY created_at DESC, id`

	sqlLockUser = `
SELECT id FROM account_users WHERE id=$1 AND disabled_at IS NULL FOR SHARE`

	sqlLiveMember = `
SELECT role FROM organization_members
 WHERE user_id = $1 AND org_id = $2
   AND status = 'active' AND NOT manual_disabled AND NOT quota_suspended
 FOR SHARE`

	sqlLiveOrg = `
SELECT id FROM organizations
 WHERE id = $1 AND dissolved_at IS NULL
 FOR SHARE`

	sqlLockUserRole = `
SELECT role FROM account_users WHERE id = $1 AND disabled_at IS NULL FOR SHARE`

	sqlInsertGrant = `
INSERT INTO automation_grants
  (user_id, org_id, scope_kind, source_ids, name, token_hash, token_prefix, actions, expires_at)
VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8::text[],
        CASE WHEN $9::bigint IS NULL THEN NULL
             ELSE clock_timestamp() + ($9::text || ' days')::interval END)
RETURNING id::text, name, token_prefix, actions, expires_at, revoked_at, last_used_at, created_at`

	sqlLockGrant = `
SELECT id::text, org_id
  FROM automation_grants
 WHERE id=$1::uuid AND user_id=$2 AND scope_kind=$3 AND org_id IS NOT DISTINCT FROM $4::bigint
 FOR UPDATE`

	sqlDeleteGrant = `
DELETE FROM automation_grants
 WHERE id=$1::uuid AND user_id=$2 AND scope_kind=$3 AND org_id IS NOT DISTINCT FROM $4::bigint`

	sqlListRuntimes = `
SELECT id::text, grant_id::text, label, renderer_contract, heartbeat_at, created_at
  FROM automation_runtimes
 WHERE org_id = $1 AND user_id = $2 AND deregistered_at IS NULL
 ORDER BY created_at DESC, id`

	sqlInsertRuntime = `
INSERT INTO automation_runtimes
     (org_id, user_id, grant_id, label, renderer_contract)
SELECT $1, $2, g.id, $3, $4
  FROM automation_grants g
 WHERE g.id = $5::uuid AND g.user_id = $2 AND g.org_id = $1
   AND g.scope_kind = 'workspace'
   AND g.revoked_at IS NULL
   AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
RETURNING automation_runtimes.id::text,
          automation_runtimes.grant_id::text,
          automation_runtimes.label,
          automation_runtimes.renderer_contract,
          automation_runtimes.heartbeat_at,
          automation_runtimes.created_at`

	sqlDeregister = `
UPDATE automation_runtimes
   SET deregistered_at = clock_timestamp()
 WHERE id = $3::uuid AND org_id = $1 AND user_id = $2
   AND deregistered_at IS NULL
RETURNING id::text, grant_id::text, label, renderer_contract, heartbeat_at, created_at`

	sqlReleaseCommands = `
UPDATE browser_commands
   SET status = 'queued', claimed_by = NULL, claim_expires_at = NULL,
       updated_at = clock_timestamp()
 WHERE org_id = $1 AND claimed_by = $2::uuid AND status = 'claimed'`

	sqlHeartbeat = `
UPDATE automation_runtimes
   SET heartbeat_at = clock_timestamp()
 WHERE id = $3::uuid AND org_id = $1 AND user_id = $2
   AND deregistered_at IS NULL
RETURNING id::text, grant_id::text, label, renderer_contract, heartbeat_at, created_at`
)
