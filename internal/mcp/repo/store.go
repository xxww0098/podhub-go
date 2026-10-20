// Package mcprepo resolves automation grants and owns execution claims.
// The statements are the SQL in spec-aomt-mcp. Business mutation SQL was not
// exported and is not invented here.
package mcprepo

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Repo uses the process pool. A nil pool fails closed.
type Repo struct {
	pool *pgxpool.Pool
}

// New binds the pool.
func New(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Resolve hashes nothing; the caller passes the SHA-256 hex of the token.
func (r *Repo) Resolve(ctx context.Context, tokenHash string) (*domain.Grant, error) {
	if r == nil || r.pool == nil {
		return nil, errors.New("mcp store unavailable")
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := scopeRole(ctx, tx, ""); err != nil {
		return nil, err
	}
	var id string
	err = tx.QueryRow(ctx, `SELECT id::text FROM automation_grants WHERE token_hash = $1`, tokenHash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	grant, err := resolveByID(ctx, tx, id, false)
	if err != nil || grant == nil {
		return grant, err
	}
	_, err = tx.Exec(ctx, `
		UPDATE automation_grants
		   SET last_used_at = clock_timestamp()
		 WHERE id = $1::uuid
		   AND (last_used_at IS NULL OR last_used_at < clock_timestamp() - interval '60 seconds')`, grant.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return grant, nil
}

// Begin claims an execution or replays the stored one.
func (r *Repo) Begin(ctx context.Context, grant domain.Grant, executionID, digest, version string) (domain.Start, error) {
	if r == nil || r.pool == nil {
		return domain.Start{}, domain.NewHost("internal", "Service is temporarily unavailable")
	}
	var out domain.Start
	err := r.inTx(ctx, db.AutomationGrant(grant.ID), func(tx pgx.Tx) error {
		live, err := resolveByID(ctx, tx, grant.ID, true)
		if err != nil {
			return internal()
		}
		if live == nil {
			return denied()
		}
		got, err := domain.Version(*live)
		if err != nil {
			return internal()
		}
		if got != version {
			return domain.NewHost("catalog_changed", "Authorization changed; call search again")
		}
		lease := uuid.NewString()
		var epoch int64
		err = tx.QueryRow(ctx, `
		INSERT INTO automation_executions
		    (grant_id, execution_id, input_digest, lease_token, lease_deadline)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, clock_timestamp() + interval '40 seconds')
		ON CONFLICT (grant_id, execution_id) DO NOTHING
		RETURNING lease_epoch`, grant.ID, executionID, digest, lease).Scan(&epoch)
		if errors.Is(err, pgx.ErrNoRows) {
			env, herr := recovered(ctx, tx, *live, executionID, true)
			if herr != nil {
				return herr
			}
			if env.Digest != digest {
				return domain.NewHost("execution_id_conflict", "executionId already names a different request")
			}
			out = domain.Start{Replay: true, Envelope: env.Envelope}
			return nil
		}
		if err != nil {
			return internal()
		}
		out = domain.Start{Claim: domain.Claim{GrantID: grant.ID, ExecutionID: executionID, LeaseToken: lease, LeaseEpoch: epoch}}
		return nil
	})
	if err != nil {
		return domain.Start{}, err
	}
	return out, nil
}

// Finish fences the conclusion and returns the envelope or a host error.
func (r *Repo) Finish(ctx context.Context, grant domain.Grant, claim domain.Claim, status string, herr *domain.HostError, calls int) (domain.Envelope, error) {
	if r == nil || r.pool == nil {
		return domain.Envelope{}, domain.NewHost("execution_finish_unavailable", "Execution recovery is required; inspect its current status")
	}
	var env domain.Envelope
	revoked := false
	err := r.inTx(ctx, db.AutomationGrant(grant.ID), func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM automation_grants WHERE id = $1::uuid FOR SHARE`, grant.ID).Scan(&locked); err != nil {
			return internal()
		}
		live, err := resolveByID(ctx, tx, grant.ID, true)
		if err != nil {
			return internal()
		}
		if live == nil {
			// The failed row is committed before not_authorized is returned.
			code := "not_authorized"
			if _, uerr := finishRow(ctx, tx, claim, "failed", &code, calls); uerr != nil {
				return internal()
			}
			revoked = true
			return nil
		}
		var code *string
		if herr != nil {
			code = &herr.Code
		}
		wrote, err := finishRow(ctx, tx, claim, status, code, calls)
		if err != nil {
			return internal()
		}
		if wrote {
			env = domain.Envelope{ExecutionID: claim.ExecutionID, Status: status, Error: herr, Calls: calls}
			env.Receipts, err = listReceipts(ctx, tx, *live, claim.ExecutionID)
			if err != nil {
				return internal()
			}
			return nil
		}
		loaded, herr := recovered(ctx, tx, *live, claim.ExecutionID, true)
		if herr != nil {
			return herr
		}
		env = loaded.Envelope
		return nil
	})
	if err != nil {
		return domain.Envelope{}, err
	}
	if revoked {
		return domain.Envelope{}, denied()
	}
	return env, nil
}

// WorkspaceName reads organizations.name for a workspace grant and fences the claim.
func (r *Repo) WorkspaceName(ctx context.Context, grant domain.Grant, claim domain.Claim) (string, error) {
	if grant.ScopeKind != "workspace" {
		return "", denied()
	}
	var name string
	err := r.inTx(ctx, db.App(grant.OrgID), func(tx pgx.Tx) error {
		if err := scopeGrant(ctx, tx, grant.ID); err != nil {
			return internal()
		}
		if err := fence(ctx, tx, claim, 1); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id = $1`, grant.OrgID).Scan(&name); err != nil {
			return domain.NewHost("domain_error", "Requested workspace data is unavailable; check permissions and filters")
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return name, nil
}

// ExecutionView is automation.executions.get. A missing row is not_authorized.
func (r *Repo) ExecutionView(ctx context.Context, grant domain.Grant, claim domain.Claim, executionID string) (domain.Envelope, error) {
	if _, err := uuid.Parse(executionID); err != nil {
		return domain.Envelope{}, domain.NewHost("invalid_execution_id", "executionId must be a UUID")
	}
	var env domain.Envelope
	err := r.inTx(ctx, db.AutomationGrant(grant.ID), func(tx pgx.Tx) error {
		if claim.LeaseToken != "" {
			if err := fence(ctx, tx, claim, 1); err != nil {
				return err
			}
		}
		loaded, herr := recovered(ctx, tx, grant, executionID, false)
		if herr != nil {
			return herr
		}
		env = loaded.Envelope
		return nil
	})
	if err != nil {
		return domain.Envelope{}, err
	}
	return env, nil
}

// inTx runs fn in session. Errors from fn are returned as-is. An unset id,
// a failed open or session, and a failed commit read as internal.
func (r *Repo) inTx(ctx context.Context, session db.Session, fn func(pgx.Tx) error) error {
	var fnErr error
	err := db.InTx(ctx, r.pool, session, func(tx pgx.Tx) error {
		fnErr = fn(tx)
		return fnErr
	})
	if err == nil || fnErr != nil {
		return err
	}
	return internal()
}

type loadedExec struct {
	Envelope domain.Envelope
	Digest   string
}

func recovered(ctx context.Context, tx pgx.Tx, grant domain.Grant, executionID string, lock bool) (loadedExec, error) {
	q := `SELECT input_digest, status, calls, error_code, lease_deadline <= clock_timestamp() AS expired
	        FROM automation_executions
	       WHERE grant_id = $1::uuid AND execution_id = $2::uuid`
	if lock {
		q += ` FOR UPDATE`
	}
	var digest, status string
	var calls int
	var errCode *string
	var expired *bool
	err := tx.QueryRow(ctx, q, grant.ID, executionID).Scan(&digest, &status, &calls, &errCode, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return loadedExec{}, denied()
	}
	if err != nil {
		return loadedExec{}, internal()
	}
	if status == "running" && expired != nil && *expired {
		if lock {
			_, err = tx.Exec(ctx, `
				UPDATE automation_executions
				   SET status = 'interrupted', error_code = 'execution_interrupted',
				       completed_at = clock_timestamp(), updated_at = clock_timestamp(),
				       lease_token = NULL, lease_deadline = NULL
				 WHERE grant_id = $1::uuid AND execution_id = $2::uuid AND status = 'running'`,
				grant.ID, executionID)
			if err != nil {
				return loadedExec{}, internal()
			}
		}
		status = "interrupted"
		code := "execution_interrupted"
		errCode = &code
	}
	env := domain.Envelope{ExecutionID: executionID, Status: status, Calls: calls, Error: errorFrom(errCode)}
	env.Receipts, err = listReceipts(ctx, tx, grant, executionID)
	if err != nil {
		return loadedExec{}, internal()
	}
	return loadedExec{Envelope: env, Digest: digest}, nil
}

func listReceipts(ctx context.Context, tx pgx.Tx, grant domain.Grant, executionID string) ([]domain.Receipt, error) {
	rows, err := tx.Query(ctx, `
		SELECT call_id, method, outcome, metadata
		  FROM automation_call_receipts
		 WHERE grant_id = $1::uuid AND execution_id = $2::uuid
		 ORDER BY created_at, call_id
		 LIMIT 20`, grant.ID, executionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Receipt
	visible := map[string]bool{}
	for _, m := range domain.Visible(grant) {
		visible[m.Name] = true
	}
	for rows.Next() {
		var rec domain.Receipt
		if err := rows.Scan(&rec.CallID, &rec.Method, &rec.Outcome, &rec.Metadata); err != nil {
			return nil, err
		}
		if !visible[rec.Method] {
			continue
		}
		out = append(out, rec)
	}
	if out == nil {
		out = []domain.Receipt{}
	}
	return out, rows.Err()
}

func finishRow(ctx context.Context, tx pgx.Tx, claim domain.Claim, status string, errCode *string, calls int) (bool, error) {
	code := filterCode(errCode)
	tag, err := tx.Exec(ctx, `
		UPDATE automation_executions
		   SET status = $5, error_code = $6, calls = GREATEST(calls, $7),
		       completed_at = clock_timestamp(), updated_at = clock_timestamp(),
		       lease_token = NULL, lease_deadline = NULL
		 WHERE grant_id = $1::uuid AND execution_id = $2::uuid
		   AND lease_token = $3::uuid AND lease_epoch = $4
		   AND status = 'running' AND lease_deadline > clock_timestamp()`,
		claim.GrantID, claim.ExecutionID, claim.LeaseToken, claim.LeaseEpoch, status, code, calls)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func fence(ctx context.Context, tx pgx.Tx, claim domain.Claim, callIndex int) error {
	tag, err := tx.Exec(ctx, `
		UPDATE automation_executions
		   SET calls = GREATEST(calls, $5), updated_at = clock_timestamp()
		 WHERE grant_id = $1::uuid AND execution_id = $2::uuid
		   AND lease_token = $3::uuid AND lease_epoch = $4
		   AND status = 'running' AND lease_deadline > clock_timestamp()`,
		claim.GrantID, claim.ExecutionID, claim.LeaseToken, claim.LeaseEpoch, callIndex)
	if err != nil {
		return internal()
	}
	if tag.RowsAffected() != 1 {
		return domain.NewHost("execution_fenced", "Execution claim is no longer active")
	}
	return nil
}

func resolveByID(ctx context.Context, tx pgx.Tx, id string, lock bool) (*domain.Grant, error) {
	q := `SELECT id::text, user_id, org_id, scope_kind, source_ids IS NULL, source_ids, actions
	        FROM automation_grants
	       WHERE id = $1::uuid AND revoked_at IS NULL
	         AND (expires_at IS NULL OR expires_at > clock_timestamp())`
	if lock {
		q += ` FOR SHARE`
	}
	var g domain.Grant
	var org *int64
	var sources []string
	err := tx.QueryRow(ctx, q, id).Scan(&g.ID, &g.UserID, &org, &g.ScopeKind, &g.SourceAll, &sources, &g.Actions)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if org != nil {
		g.OrgID = *org
	}
	g.SourceIDs = sources
	if !actionsFit(g.ScopeKind, g.Actions) {
		return nil, nil
	}
	userQ := `SELECT u.id, u.role, p.supplier_id
	            FROM account_users u
	            JOIN account_profiles p ON p.user_id = u.id
	           WHERE u.id = $1 AND u.disabled_at IS NULL`
	if lock {
		userQ += ` FOR SHARE OF u`
	}
	var role, supplier string
	var uid int64
	err = tx.QueryRow(ctx, userQ, g.UserID).Scan(&uid, &role, &supplier)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g.PlatformRole = role
	_ = supplier
	switch g.ScopeKind {
	case "workspace":
		if g.OrgID <= 0 {
			return nil, nil
		}
		memQ := `SELECT role FROM organization_members
		          WHERE user_id = $1 AND org_id = $2 AND status = 'active'
		            AND NOT manual_disabled AND NOT quota_suspended`
		if lock {
			memQ += ` FOR SHARE`
		}
		var stored string
		err = tx.QueryRow(ctx, memQ, g.UserID, g.OrgID).Scan(&stored)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		norm, ok := storedRole(stored)
		if !ok {
			return nil, nil
		}
		g.WorkspaceRole = norm
		orgQ := `SELECT id FROM organizations WHERE id = $1 AND dissolved_at IS NULL`
		if lock {
			orgQ += ` FOR SHARE`
		}
		var oid int64
		err = tx.QueryRow(ctx, orgQ, g.OrgID).Scan(&oid)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
	case "supplier_catalog":
		if !staffRole(role) {
			return nil, nil
		}
	case "catalog":
	default:
		return nil, nil
	}
	return &g, nil
}

func storedRole(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "owner":
		return "owner", true
	case "manager", "admin":
		return "manager", true
	case "member":
		return "member", true
	case "reviewer":
		return "reviewer", true
	case "viewer":
		return "viewer", true
	default:
		return "", false
	}
}

func staffRole(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin", "super_admin":
		return true
	default:
		return false
	}
}

func actionsFit(scope string, actions []string) bool {
	if len(actions) == 0 {
		return false
	}
	var allow []string
	switch scope {
	case "workspace":
		allow = []string{"read", "prepare", "submit", "catalog:read", "cards:write"}
	case "catalog":
		allow = []string{"catalog:read"}
	case "supplier_catalog":
		allow = []string{"supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price"}
	default:
		return false
	}
	for _, action := range actions {
		if !contains(allow, action) {
			return false
		}
	}
	return true
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func scopeRole(ctx context.Context, tx pgx.Tx, grantID string) error {
	if grantID == "" {
		_, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp)
		return err
	}
	return scopeGrant(ctx, tx, grantID)
}

func scopeGrant(ctx context.Context, tx pgx.Tx, grantID string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('role', $1, true), set_config('app.automation_grant_id', $2, true)`, tenantx.RoleApp, grantID)
	return err
}

func filterCode(code *string) *string {
	if code == nil {
		return nil
	}
	if len(*code) == 0 || len(*code) > 100 {
		return nil
	}
	for _, r := range *code {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
			return nil
		}
	}
	return code
}

func errorFrom(code *string) *domain.HostError {
	kept := filterCode(code)
	if kept == nil {
		return nil
	}
	return domain.NewHost(*kept, "Execution ended; inspect currently visible receipts")
}

func denied() *domain.HostError {
	return domain.NewHost("not_authorized", "Current grant does not authorize this request")
}

func internal() *domain.HostError {
	return domain.NewHost("internal", "Service is temporarily unavailable")
}
