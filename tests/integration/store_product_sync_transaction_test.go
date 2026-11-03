package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	storehttp "github.com/xxww0098/podhub-go/internal/store/http"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
)

func TestProductSyncNowCommitsAuditAndRollsBackFailures(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "entitlement", "product sync transaction")

	const userID = int64(97801)
	const storeID = "00000000-0000-4000-8000-000000000801"
	orgID := seedCompanyOrg(t, ctx, pool, userID, "product-sync-commit")
	seedCompanyMember(t, ctx, pool, orgID, userID, "owner", 1)
	seedCompanyStore(t, ctx, pool, orgID, storeID, 1, "sync fixture", nil)
	directory := storerepo.New(pool, tenantx.BeginApp)
	svc := storesvc.New(directory, nil).WithRoster(directory)
	postSync := func(org, user int64, store string) *httptest.ResponseRecorder {
		router := chi.NewRouter()
		storehttp.Mount(router, storehttp.Deps{
			Resolve: func(*http.Request) (*storehttp.Session, *storehttp.Refusal, error) {
				return &storehttp.Session{UserID: user, OrgID: org, WorkspaceRole: "owner"}, nil, nil
			},
			Products: svc,
		})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/workspaces/stores/"+store+"/products/sync", nil))
		return rec
	}

	accepted := postSync(orgID, userID, storeID)
	var press struct {
		Generation            int64 `json:"generation"`
		Attached              bool  `json:"attached"`
		ManualNextAllowedAtMS int64 `json:"manual_next_allowed_at_ms"`
	}
	if err := json.Unmarshal(accepted.Body.Bytes(), &press); err != nil || accepted.Code != http.StatusAccepted || press.Generation != 1 || press.Attached || press.ManualNextAllowedAtMS <= 0 {
		t.Fatalf("sync status=%d press=%+v decode error=%v", accepted.Code, press, err)
	}
	var generation, requested, due int64
	if err := pool.QueryRow(ctx, `SELECT refresh_generation, manual_requested_at_ms, next_due_at_ms
		FROM store_product_sync WHERE org_id=$1 AND store_id=$2::uuid`, orgID, storeID).Scan(&generation, &requested, &due); err != nil {
		t.Fatalf("scheduled sync was not committed: %v", err)
	}
	if generation != press.Generation || requested <= 0 || due != requested || press.ManualNextAllowedAtMS <= requested {
		t.Fatalf("committed sync disagrees with response: press=%+v generation=%d requested=%d due=%d", press, generation, requested, due)
	}
	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND entity_id=$2 AND action='product_sync_now'`, orgID, storeID).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("sync audit count=%d error=%v", audits, err)
	}

	if rejected := postSync(orgID, userID, storeID); rejected.Code != http.StatusTooManyRequests {
		t.Fatalf("repeated sync should preserve cooldown refusal: status=%d body=%s", rejected.Code, rejected.Body.String())
	}
	var requestedAfter int64
	if err := pool.QueryRow(ctx, `SELECT manual_requested_at_ms FROM store_product_sync
		WHERE org_id=$1 AND store_id=$2::uuid`, orgID, storeID).Scan(&requestedAfter); err != nil || requestedAfter != requested {
		t.Fatalf("refused sync changed its request time: got %d want %d error=%v", requestedAfter, requested, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND entity_id=$2 AND action='product_sync_now'`, orgID, storeID).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("refused sync added an audit: count=%d error=%v", audits, err)
	}

	const failedUser = int64(97802)
	const failedStore = "00000000-0000-4000-8000-000000000802"
	failedOrg := seedCompanyOrg(t, ctx, pool, failedUser, "product-sync-rollback")
	seedCompanyMember(t, ctx, pool, failedOrg, failedUser, "owner", 1)
	seedCompanyStore(t, ctx, pool, failedOrg, failedStore, 1, "failed sync fixture", nil)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_product_sync_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$;
		CREATE TRIGGER reject_product_sync_audit BEFORE INSERT ON audit_logs
		FOR EACH ROW WHEN (NEW.action = 'product_sync_now') EXECUTE FUNCTION reject_product_sync_audit()`); err != nil {
		t.Fatal(err)
	}
	if failed := postSync(failedOrg, failedUser, failedStore); failed.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure returned success or wrong error: status=%d body=%s", failed.Code, failed.Body.String())
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM store_product_sync WHERE org_id=$1 AND store_id=$2::uuid`, failedOrg, failedStore).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("failed sync left a scheduled row: count=%d error=%v", rows, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id=$1 AND action='product_sync_now'`, failedOrg).Scan(&audits); err != nil || audits != 0 {
		t.Fatalf("failed sync left an audit: count=%d error=%v", audits, err)
	}
}
