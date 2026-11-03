-- name: PlatformReady :one
SELECT (owner_account_id IS NOT NULL)::bool AS ready
FROM platform_initialization
WHERE singleton = true
LIMIT 1;

-- name: InsertAccountUser :one
INSERT INTO account_users (
    public_id, email, password_hash, role, name, target, supplier_id, plan,
    invited_by_agent_user_id, agent_attributed_at, agent_attribution_bps,
    agent_attribution_source, created_at, updated_at
) VALUES (
    $1, $2, $3, 'user', $4, '/workspace', '', 'lite',
    NULL, NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
)
ON CONFLICT (lower(email)) DO NOTHING
RETURNING id, public_id, email, password_hash, role, name, target, supplier_id;

-- name: FindUserByEmail :one
SELECT u.id, u.public_id, u.email, c.password_hash, u.session_revision, u.role, p.name, p.target,
       p.supplier_id, (u.disabled_at IS NOT NULL)::bool AS disabled
FROM account_users u
JOIN account_credentials c ON c.user_id = u.id
JOIN account_profiles p ON p.user_id = u.id
WHERE lower(u.email) = lower(sqlc.arg(email)::text)
LIMIT 1;

-- name: IssueSession :exec
INSERT INTO account_sessions (token_hash, user_id, expires_at)
VALUES ($1, $2, ($3::text)::timestamptz)
ON CONFLICT (token_hash) DO UPDATE
    SET expires_at = EXCLUDED.expires_at
WHERE account_sessions.user_id = EXCLUDED.user_id;

-- name: TouchLastLogin :exec
UPDATE account_users SET last_login_at = clock_timestamp() WHERE id = $1;

-- name: InsertAudit :exec
INSERT INTO audit_logs (
    org_id, user_id, module, entity_type, entity_id, api_method, api_path,
    action, status, result, message, shop_id, created_at_ms, created_at,
    actor_kind, support_grant_id, writer_lease_id, writer_fence_token
) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    $8, 'success', 'applied', $9, NULL,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
    clock_timestamp(), 'user', NULL, NULL, NULL
);

-- name: ResolveAccount :one
SELECT u.id, u.public_id, u.email, u.role, p.name, p.supplier_id,
       u.account_kind, u.must_change_password,
       COALESCE(active_workspace.org_id, 0)::bigint AS org_id,
       COALESCE(active_workspace.workspace_role, '')::text AS workspace_role
FROM account_sessions s
JOIN account_users u ON u.id = s.user_id
JOIN account_profiles p ON p.user_id = u.id
LEFT JOIN LATERAL (
    SELECT o.id AS org_id, m.role AS workspace_role
    FROM organization_members m
    JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = u.id
      AND m.status = 'active'
      AND NOT m.manual_disabled
      AND NOT m.quota_suspended
      AND o.dissolved_at IS NULL
    ORDER BY (o.id = p.active_org_id) DESC NULLS LAST,
             (m.role = 'owner') DESC, o.id ASC
    LIMIT 1
) active_workspace ON true
WHERE s.token_hash = $1
  AND s.expires_at > clock_timestamp()
  AND u.disabled_at IS NULL
LIMIT 1;

-- name: DeleteSessionByHash :execrows
DELETE FROM account_sessions WHERE token_hash = $1;

-- name: DeleteSessionsByHashes :execrows
DELETE FROM account_sessions WHERE token_hash = ANY($1::text[]);

-- name: DeleteUserSessions :execrows
DELETE FROM account_sessions WHERE user_id = $1;

-- name: ListWorkspaces :many
SELECT o.id, lower(o.uuid::text) AS uuid, o.name, o.plan, m.role,
       (m.role = 'owner')::bool AS is_owned,
       (SELECT COUNT(*)::bigint FROM organization_members c WHERE c.org_id = o.id) AS member_count,
       CASE WHEN o.avatar_bytes IS NOT NULL THEN o.avatar_updated_at_ms END AS avatar_revision
FROM organization_members m
JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1
  AND m.status = 'active'
  AND NOT m.manual_disabled
  AND NOT m.quota_suspended
  AND o.dissolved_at IS NULL
ORDER BY (m.role = 'owner') DESC, o.id ASC;

-- name: ListUnusableWorkspaces :many
SELECT o.id, lower(o.uuid::text) AS uuid, o.name, o.plan, m.role,
       (m.role = 'owner')::bool AS is_owned,
       (SELECT COUNT(*)::bigint FROM organization_members c WHERE c.org_id = o.id) AS member_count,
       CASE WHEN o.avatar_bytes IS NOT NULL THEN o.avatar_updated_at_ms END AS avatar_revision
FROM organization_members m
JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1
  AND (m.manual_disabled OR m.quota_suspended)
  AND o.dissolved_at IS NULL
ORDER BY m.id ASC;

-- name: SetActiveOrg :exec
UPDATE account_users
SET active_org_id = $1, updated_at = clock_timestamp()
WHERE id = $2;

-- name: UserActiveOrg :one
SELECT active_org_id FROM account_users WHERE id = $1;

-- name: LockAccount :one
SELECT id FROM account_users WHERE id = $1 FOR NO KEY UPDATE;

-- name: FirstOwnedOrg :one
SELECT o.id
FROM organization_members m
JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1 AND m.role = 'owner' AND o.dissolved_at IS NULL
ORDER BY o.id ASC
LIMIT 1;

-- name: PlanActive :one
SELECT key FROM plans WHERE key = $1 AND active = true LIMIT 1;

-- name: InsertOrganization :one
INSERT INTO organizations (
    owner_user_id, name, plan, uuid,
    created_at, updated_at
) VALUES (
    $1, $2, $3, gen_random_uuid(), clock_timestamp(), clock_timestamp()
)
RETURNING id;

-- name: LockOrganization :one
SELECT id FROM organizations WHERE id = $1 FOR UPDATE;

-- name: NextJoinOrder :one
SELECT (COALESCE(MAX(join_order), 0) + 1)::bigint AS value
FROM organization_members
WHERE org_id = $1;

-- name: AttachOwner :exec
INSERT INTO organization_members (
    org_id, user_id, role, status, join_order, display_name, created_at, updated_at
) VALUES (
    $1, $2, 'owner', 'active', $3, $4, clock_timestamp(), clock_timestamp()
)
ON CONFLICT (org_id, user_id) DO NOTHING;

-- name: AccountStanding :one
SELECT
    (SELECT COUNT(*)::bigint
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.role = 'owner'
        AND o.dissolved_at IS NULL) AS owned_count,
    (SELECT COUNT(*)::bigint FROM organization_members
      WHERE user_id = $1 AND status = 'active') AS membership_count;

-- name: LoginWaiting :one
SELECT (next_allowed_at > clock_timestamp())::bool AS waiting
FROM auth_login_attempts
WHERE email_hash = $1 AND ip_hash = $2;

-- name: BumpLoginAttempt :exec
INSERT INTO auth_login_attempts AS current
    (email_hash, ip_hash, failures, window_start, next_allowed_at, updated_at)
VALUES ($1, $2, 1, clock_timestamp(), clock_timestamp(), clock_timestamp())
ON CONFLICT (email_hash, ip_hash) DO UPDATE SET
    failures = CASE
        WHEN current.updated_at <= clock_timestamp() - interval '15 minutes'
         AND current.next_allowed_at <= clock_timestamp()
        THEN 1
        ELSE current.failures + 1
    END,
    window_start = CASE
        WHEN current.updated_at <= clock_timestamp() - interval '15 minutes'
         AND current.next_allowed_at <= clock_timestamp()
        THEN clock_timestamp()
        ELSE current.window_start
    END,
    updated_at = clock_timestamp(),
    next_allowed_at = clock_timestamp() + make_interval(secs => CASE
        WHEN (CASE
            WHEN current.updated_at <= clock_timestamp() - interval '15 minutes'
             AND current.next_allowed_at <= clock_timestamp()
            THEN 1
            ELSE current.failures + 1
        END) <= $3::integer
        THEN 0
        ELSE least(900, (2 << least(
            (CASE
                WHEN current.updated_at <= clock_timestamp() - interval '15 minutes'
                 AND current.next_allowed_at <= clock_timestamp()
                THEN 1
                ELSE current.failures + 1
            END) - $3::integer - 1, 15)))
    END);

-- name: ClearLoginAttempt :exec
DELETE FROM auth_login_attempts WHERE email_hash = $1 AND ip_hash = $2;

-- name: PruneLoginAttempts :exec
DELETE FROM auth_login_attempts
WHERE ctid IN (
    SELECT ctid FROM auth_login_attempts
    WHERE updated_at < clock_timestamp() - interval '1 day'
    LIMIT $1
);

-- name: AssertPassword :one
SELECT password_hash, email, session_revision, (disabled_at IS NOT NULL)::bool AS disabled, role
FROM account_users
WHERE id = $1
FOR UPDATE;

-- name: ReplacePassword :exec
UPDATE account_users
SET password_hash = $1, updated_at = clock_timestamp()
WHERE id = $2;

-- name: ClearMustChangePassword :exec
UPDATE account_users
SET must_change_password = false
WHERE id = $1;

-- name: ConsumeEmailToken :one
UPDATE auth_email_tokens
SET consumed_at = clock_timestamp()
WHERE auth_email_tokens.token_hash = $1
  AND purpose = $2
  AND consumed_at IS NULL
  AND expires_at > clock_timestamp()
  AND NOT EXISTS (SELECT 1 FROM auth_password_reset_deliveries d WHERE d.token_hash=auth_email_tokens.token_hash AND d.state IN ('failed','cancelled'))
RETURNING user_id;

-- name: LockUserState :one
SELECT (disabled_at IS NOT NULL)::bool AS disabled,
       email
FROM account_users
WHERE id = $1
FOR UPDATE;

-- name: ProfileName :one
SELECT name, name_changed_at_ms
FROM account_profiles
WHERE user_id = $1;

-- name: UpdateUserName :exec
UPDATE account_users
SET name = $1, updated_at = clock_timestamp()
WHERE id = $2;

-- name: StampNameChanged :exec
UPDATE account_profiles
SET name_changed_at_ms = $1
WHERE user_id = $2;

-- name: UpdateMemberNames :exec
UPDATE organization_members
SET display_name = $1, updated_at = clock_timestamp()
WHERE user_id = $2;

-- name: ProfileMarks :one
SELECT CASE WHEN avatar_bytes IS NOT NULL THEN avatar_updated_at_ms END AS avatar_revision,
       name_changed_at_ms
FROM account_profiles
WHERE user_id = $1;

-- name: DirectoryMembers :many
SELECT m.id, m.user_id, m.role, m.display_name, u.email, m.manual_disabled, m.quota_suspended,
       (EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint AS joined_at_ms
FROM organization_members m
JOIN account_users u ON u.id = m.user_id
WHERE m.org_id = $1
ORDER BY m.join_order ASC, m.id ASC;

-- name: DirectoryInvitations :many
SELECT i.id, lower(i.uuid::text) AS uuid, i.email, i.role, i.invited_by_email,
       (EXTRACT(EPOCH FROM i.created_at) * 1000)::bigint AS created_at_ms,
       (EXTRACT(EPOCH FROM i.expires_at) * 1000)::bigint AS expires_at_ms
FROM org_invitations i
WHERE i.org_id = $1
  AND i.accepted_at IS NULL
  AND i.revoked_at IS NULL
  AND i.declined_at IS NULL
  AND i.expires_at > clock_timestamp()
ORDER BY i.created_at DESC, i.id DESC;

-- name: BindInvitations :execrows
UPDATE org_invitations AS i
SET invitee_user_id = $1, updated_at = clock_timestamp()
FROM organizations AS o
WHERE o.id = i.org_id
  AND lower(i.email) = lower($2)
  AND i.accepted_at IS NULL
  AND i.revoked_at IS NULL
  AND i.declined_at IS NULL
  AND i.expires_at > clock_timestamp();

-- name: CountCardCursors :one
SELECT count(*)::bigint AS n FROM listing_card_cursors;

-- name: InsertCardCursor :exec
INSERT INTO listing_card_cursors (org_id, card_id)
VALUES ($1, $2::uuid);

-- name: InsertFreeSubscription :exec
INSERT INTO subscriptions (org_id, status, plan_key, revision, updated_at)
VALUES ($1, 'free', 'free', 1, clock_timestamp())
ON CONFLICT (org_id) DO NOTHING;
