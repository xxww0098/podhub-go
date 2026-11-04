package readhttp

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/identity/contract"
)

// StoreScope exposes the job read scope to the generated HTTP layer.
func StoreScope(ctx context.Context, pool *pgxpool.Pool, org, user int64) (bool, []string, error) {
	h := Host{Pool: pool}
	scope, err := h.storeScope(ctx, org, user)
	return scope.all, scope.stores, err
}

// storeScope is the store set a workspace member may touch. Owners and
// managers see every store; a member sees only stores assigned to them.
// Resources without a store are workspace-shared drafts and stay visible.
type storeScope struct {
	all    bool
	stores []string
}

func (h Host) storeScope(ctx context.Context, org, user int64) (storeScope, error) {
	var scope storeScope
	var role string
	err := h.withOrg(ctx, org, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT m.role,
			       COALESCE(array_agg(s.uuid::text) FILTER (WHERE s.id IS NOT NULL), '{}')
			  FROM organization_members m
			  LEFT JOIN organization_stores s
			    ON s.org_id = m.org_id
			   AND s.assignee_membership_id = m.id
			   AND s.deleted_at_ms IS NULL
			 WHERE m.org_id = $1 AND m.user_id = $2
			   AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
			 GROUP BY m.role`, org, user).Scan(&role, &scope.stores)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return scope, nil
	}
	if err != nil {
		return scope, err
	}
	parsed, ok := contract.ParseWorkspace(role)
	if ok && parsed.CanManage() {
		scope.all = true
		scope.stores = nil
	}
	return scope, nil
}

func (s storeScope) allows(store *string) bool {
	if store == nil || strings.TrimSpace(*store) == "" {
		return true
	}
	if s.all {
		return true
	}
	for _, id := range s.stores {
		if id == *store {
			return true
		}
	}
	return false
}

// rowStoreExpr resolves a listing row's store. An unbound row inherits the
// card's store, matching the create path.
const rowStoreExpr = `COALESCE(listing_rows.store_id,
	(SELECT c.store_id FROM listing_cards c
	  WHERE c.org_id = listing_rows.org_id AND c.id = listing_rows.card_id))`

func (s storeScope) rowFilter(arg int) string {
	if s.all {
		return ""
	}
	slot := "$" + strconv.Itoa(arg) + "::uuid[]"
	return " AND (" + rowStoreExpr + " IS NULL OR " + rowStoreExpr + " = ANY(" + slot + "))"
}

func (s storeScope) cardFilter(arg int) string {
	if s.all {
		return ""
	}
	slot := "$" + strconv.Itoa(arg) + "::uuid[]"
	return " AND (listing_cards.store_id IS NULL OR listing_cards.store_id = ANY(" + slot + "))"
}

// storeAllowedTx answers whether user may touch store. A nil or empty store is
// a workspace-shared resource.
func storeAllowedTx(ctx context.Context, tx pgx.Tx, org, user int64, store *string) (bool, error) {
	if store == nil || strings.TrimSpace(*store) == "" {
		return true, nil
	}
	var assignee, membership *int64
	var role *string
	err := tx.QueryRow(ctx, `
		SELECT s.assignee_membership_id, m.id, m.role
		  FROM organization_stores s
		  LEFT JOIN organization_members m
		    ON m.org_id = s.org_id AND m.user_id = $3
		   AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
		 LIMIT 1`, org, *store, user).Scan(&assignee, &membership, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if membership == nil {
		return false, nil
	}
	return storeVisible(roleString(role), assignee, *membership), nil
}

func rowStoreTx(ctx context.Context, tx pgx.Tx, org int64, rowID string) (*string, error) {
	var store *string
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(r.store_id, c.store_id)::text
		  FROM listing_rows r
		  JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
		 WHERE r.org_id = $1 AND r.id = $2::uuid`, org, rowID).Scan(&store)
	return store, err
}

func rowAllowedTx(ctx context.Context, tx pgx.Tx, org, user int64, rowID string) (bool, error) {
	store, err := rowStoreTx(ctx, tx, org, rowID)
	if err != nil {
		return false, err
	}
	return storeAllowedTx(ctx, tx, org, user, store)
}

func (s storeScope) jobFilter(userArg, storesArg int) string {
	if s.all {
		return ""
	}
	user := "$" + strconv.Itoa(userArg) + "::bigint"
	slot := "$" + strconv.Itoa(storesArg) + "::uuid[]"
	return ` AND (submitter_user_id = ` + user + ` OR EXISTS (
		SELECT 1 FROM listing_rows r
		LEFT JOIN listing_cards c ON c.org_id = r.org_id AND c.id = r.card_id
		WHERE r.org_id = jobs.org_id AND r.id = jobs.aggregate_id
		  AND (COALESCE(r.store_id, c.store_id) IS NULL
		       OR COALESCE(r.store_id, c.store_id) = ANY(` + slot + `))))`
}

// jobAllowedTx reports whether user may see or drive one job. Managers see
// every job; a member sees their own submissions and jobs for assigned stores.
func jobAllowedTx(ctx context.Context, tx pgx.Tx, org, user int64, jobID string) (bool, error) {
	var role string
	err := tx.QueryRow(ctx, `
		SELECT m.role FROM organization_members m
		 WHERE m.org_id = $1 AND m.user_id = $2
		   AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended`, org, user).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	parsed, ok := contract.ParseWorkspace(role)
	if ok && parsed.CanManage() {
		return true, nil
	}
	var aggregateType, aggregateID string
	var submitter *int64
	err = tx.QueryRow(ctx, `
		SELECT aggregate_type, aggregate_id::text, submitter_user_id
		  FROM jobs WHERE org_id = $1 AND id = $2::uuid`, org, jobID).Scan(&aggregateType, &aggregateID, &submitter)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if submitter != nil && *submitter == user {
		return true, nil
	}
	if aggregateType != "listing_row" {
		return false, nil
	}
	return rowAllowedTx(ctx, tx, org, user, aggregateID)
}

func (h Host) requireJob(w http.ResponseWriter, r *http.Request, p contract.Principal, jobID string) bool {
	allowed, err := h.jobAllowed(r, p, jobID)
	if err != nil {
		writeDB(w, err)
		return false
	}
	if !allowed {
		writeErr(w, http.StatusNotFound, "作业不存在", "not_found")
		return false
	}
	return true
}

func (h Host) jobAllowed(r *http.Request, p contract.Principal, jobID string) (bool, error) {
	var allowed bool
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		var err error
		allowed, err = jobAllowedTx(r.Context(), tx, p.OrgID, p.UserID, jobID)
		return err
	})
	return allowed, err
}

// requireRow writes 404 unless the row belongs to a store visible to p.
func (h Host) requireRow(w http.ResponseWriter, r *http.Request, p contract.Principal, rowID string) bool {
	var allowed bool
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		var err error
		allowed, err = rowAllowedTx(r.Context(), tx, p.OrgID, p.UserID, rowID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "商品行不存在", "not_found")
		return false
	}
	if err != nil {
		writeDB(w, err)
		return false
	}
	if !allowed {
		writeErr(w, http.StatusNotFound, "商品行不存在", "not_found")
		return false
	}
	return true
}
