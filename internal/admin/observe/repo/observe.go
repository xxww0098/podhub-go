package observerepo

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	observecontract "github.com/xxww0098/podhub-go/internal/admin/observe/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Observe is the platform observation SQL. Fetch loads product thumbnails.
type Observe struct {
	Pool  *pgxpool.Pool
	Fetch Fetch
	Now   func() time.Time
}

// NewObserve builds the observation store.
func NewObserve(pool *pgxpool.Pool, fetch Fetch) *Observe {
	return &Observe{Pool: pool, Fetch: fetch, Now: time.Now}
}

func (r *Observe) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

type obsWorkspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	OwnerUUID string `json:"ownerUuid"`
	OwnerName string `json:"ownerName"`
	orgID     int64
}

type obsStore struct {
	StoreID       string  `json:"storeId"`
	StoreName     string  `json:"storeName"`
	WorkspaceID   string  `json:"workspaceId"`
	WorkspaceName string  `json:"workspaceName"`
	OwnerUUID     string  `json:"ownerUuid"`
	OwnerName     string  `json:"ownerName"`
	Manual        bool    `json:"-"`
	Quota         bool    `json:"-"`
	Assignee      *string `json:"-"`
}

func (r *Observe) beginObserve(ctx context.Context, actor corecontract.Actor) (pgx.Tx, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		SELECT set_config('role', $1, true), set_config($2, '', true), set_config('app.platform_observer_id', $3, true)`,
		tenantx.RoleApp, tenantx.GUCCurrentOrgID, strconv.FormatInt(actor.UserID, 10)); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if err := ensureObserver(ctx, tx, actor.UserID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func ensureObserver(ctx context.Context, tx pgx.Tx, userID int64) error {
	var allowed bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM account_users WHERE id = $1 AND role = 'super_admin' AND disabled_at IS NULL)`, userID).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return corecontract.Forbidden("forbidden", "需要超级管理员观察权限")
	}
	return nil
}

func (r *Observe) auditObserve(ctx context.Context, actor corecontract.Actor, orgID int64, entityID, path, action string, scope observecontract.Scope, workspaces, stores, rows int) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true), set_config('app.platform_observer_id', '', true), set_config($2, '', true)`,
		tenantx.RoleApp, tenantx.GUCCurrentOrgID); err != nil {
		return err
	}
	var workspaceID, storeID *string
	if scope.WorkspaceID != "" {
		workspaceID = &scope.WorkspaceID
	}
	if scope.StoreID != "" {
		storeID = &scope.StoreID
	}
	message, _ := json.Marshal(struct {
		WorkspaceID    *string `json:"workspaceId"`
		StoreID        *string `json:"storeId"`
		WorkspaceCount int     `json:"workspaceCount"`
		StoreCount     int     `json:"storeCount"`
		RowCount       int     `json:"rowCount"`
	}{workspaceID, storeID, workspaces, stores, rows})
	if err := corerepo.AuditBill(ctx, tx, orgID, actor.UserID, "platform_observation", "observation_scope", entityID, "GET", path, action, string(message), corerepo.Lease{}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func normalizeScope(scope observecontract.Scope) (observecontract.Scope, error) {
	if scope.WorkspaceID != "" {
		id, ok := corecontract.NormalizeUUID(scope.WorkspaceID)
		if !ok {
			return observecontract.Scope{}, corecontract.Validation("validation", "范围 UUID 无效")
		}
		scope.WorkspaceID = id
	}
	if scope.StoreID != "" {
		id, ok := corecontract.NormalizeUUID(scope.StoreID)
		if !ok {
			return observecontract.Scope{}, corecontract.Validation("validation", "范围 UUID 无效")
		}
		scope.StoreID = id
	}
	return scope, nil
}

func loadScope(ctx context.Context, tx pgx.Tx, scope observecontract.Scope) ([]obsWorkspace, []obsStore, *int64, error) {
	var wsArg, storeArg any
	if scope.WorkspaceID != "" {
		wsArg = scope.WorkspaceID
	}
	if scope.StoreID != "" {
		storeArg = scope.StoreID
	}
	rows, err := tx.Query(ctx, `
		SELECT o.id, o.uuid::text, o.name, u.public_id, p.name
		  FROM organizations o
		  JOIN account_users u ON u.id = o.owner_user_id
		  JOIN account_profiles p ON p.user_id = u.id
		 WHERE o.dissolved_at IS NULL
		   AND ($1::uuid IS NULL OR o.uuid = $1::uuid)
		   AND ($2::uuid IS NULL OR EXISTS (
		        SELECT 1 FROM organization_stores s
		         WHERE s.org_id = o.id AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL))
		 ORDER BY lower(o.name), o.uuid`, wsArg, storeArg)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()
	workspaces := []obsWorkspace{}
	for rows.Next() {
		var item obsWorkspace
		if err := rows.Scan(&item.orgID, &item.ID, &item.Name, &item.OwnerUUID, &item.OwnerName); err != nil {
			return nil, nil, nil, err
		}
		workspaces = append(workspaces, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	filtered := scope.WorkspaceID != "" || scope.StoreID != ""
	if filtered && len(workspaces) == 0 {
		return nil, nil, nil, corecontract.NotFound("not_found", "观察范围不存在")
	}
	var orgID *int64
	if scope.WorkspaceID != "" && len(workspaces) > 0 {
		orgID = &workspaces[0].orgID
	}
	stores, err := loadStores(ctx, tx, orgID, storeArg)
	if err != nil {
		return nil, nil, nil, err
	}
	if scope.StoreID != "" && len(stores) == 0 {
		return nil, nil, nil, corecontract.NotFound("not_found", "观察范围不存在")
	}
	return workspaces, stores, orgID, nil
}

func loadStores(ctx context.Context, tx pgx.Tx, orgID *int64, store any) ([]obsStore, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.uuid::text, s.name, o.uuid::text, o.name, u.public_id, p.name,
		       s.manual_disabled, s.quota_suspended,
		       (SELECT p2.name FROM organization_members m
		          JOIN account_profiles p2 ON p2.user_id = m.user_id
		         WHERE m.id = s.assignee_membership_id)
		  FROM organization_stores s
		  JOIN organizations o ON o.id = s.org_id
		  JOIN account_users u ON u.id = o.owner_user_id
		  JOIN account_profiles p ON p.user_id = u.id
		 WHERE s.deleted_at_ms IS NULL AND o.dissolved_at IS NULL
		   AND ($1::bigint IS NULL OR s.org_id = $1)
		   AND ($2::uuid IS NULL OR s.uuid = $2::uuid)
		 ORDER BY o.uuid, s.uuid`, orgID, store)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []obsStore{}
	for rows.Next() {
		var item obsStore
		if err := rows.Scan(&item.StoreID, &item.StoreName, &item.WorkspaceID, &item.WorkspaceName, &item.OwnerUUID, &item.OwnerName,
			&item.Manual, &item.Quota, &item.Assignee); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *Observe) finishObserve(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, scope observecontract.Scope) error {
	if scope.WorkspaceID != "" || scope.StoreID != "" {
		if _, _, _, err := loadScope(ctx, tx, scope); err != nil {
			return err
		}
	}
	if err := ensureObserver(ctx, tx, actor.UserID); err != nil {
		return err
	}
	return tx.Rollback(ctx)
}

func scopeOrg(workspaces []obsWorkspace, scope observecontract.Scope) int64 {
	if scope.WorkspaceID == "" {
		return 0
	}
	for _, item := range workspaces {
		if item.ID == scope.WorkspaceID {
			return item.orgID
		}
	}
	if len(workspaces) > 0 {
		return workspaces[0].orgID
	}
	return 0
}

func entityOf(scope observecontract.Scope) string {
	if scope.WorkspaceID != "" {
		return scope.WorkspaceID
	}
	return "all"
}

func (r *Observe) Scopes(ctx context.Context, actor corecontract.Actor, scope observecontract.Scope) ([]byte, error) {
	scope, err := normalizeScope(scope)
	if err != nil {
		return nil, err
	}
	tx, err := r.beginObserve(ctx, actor)
	if err != nil {
		return nil, corerepo.MapBill(err, "internal", false)
	}
	workspaces, stores, _, err := loadScope(ctx, tx, scope)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", false)
	}
	if err := r.finishObserve(ctx, tx, actor, scope); err != nil {
		return nil, corerepo.MapBill(err, "internal", false)
	}
	if err := r.auditObserve(ctx, actor, scopeOrg(workspaces, scope), entityOf(scope), "/api/admin/ops/scopes", "observation_scopes", scope, len(workspaces), len(stores), len(stores)); err != nil {
		return nil, corerepo.MapBill(err, "internal", false)
	}
	pubWS := make([]obsWorkspace, len(workspaces))
	copy(pubWS, workspaces)
	pubStores := make([]obsStore, len(stores))
	copy(pubStores, stores)
	return corerepo.Data(struct {
		Workspaces []obsWorkspace `json:"workspaces"`
		Stores     []obsStore     `json:"stores"`
	}{pubWS, pubStores})
}
