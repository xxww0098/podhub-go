package ratingsrepo

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/ratings/domain"
	ratinghttp "github.com/xxww0098/podhub-go/internal/ratings/http"
	ratingsvc "github.com/xxww0098/podhub-go/internal/ratings/service"
)

func TestListDoesNotLock(t *testing.T) {
	if strings.Contains(ListSQL(), "FOR UPDATE") {
		t.Fatal("list takes a row lock")
	}
}

func TestRatingsParity(t *testing.T) {
	pool, ctx := parityDB(t)
	const secret = "fixture-api-key-rt1"
	userA, userB := int64(994001), int64(994002)
	userV := int64(994003)
	orgA, _, uuidA := seedRatingOrg(t, ctx, pool, userA, "a")
	orgB, _, uuidB := seedRatingOrg(t, ctx, pool, userB, "b")
	memberV := addMember(t, ctx, pool, orgA, userV, "member", 2)

	repo := New(pool)
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	one := "1"
	two := "2"
	ranks := map[string]int{"OK": 1, "BAD": 2}
	first := []domain.Rating{
		{Key: "rating_delivery_complaints_fbo", Name: "Жалобы по FBO", ValueType: "RATIO", Status: "UNKNOWN"},
		{Key: "rating_price_green", Name: "价格指数", ValueType: "WEIRD", Status: "OK", Current: &one},
	}
	got, err := repo.Apply(ctx, orgA, uuidA, first, now, domain.DefaultRanks())
	if err != nil || got.History != 2 || got.Noted != 0 {
		t.Fatalf("first %+v %v", got, err)
	}
	again, err := repo.Apply(ctx, orgA, uuidA, first, now.Add(time.Minute), domain.DefaultRanks())
	if err != nil || again.History != 0 || again.Noted != 0 {
		t.Fatalf("same %+v %v", again, err)
	}
	n, err := repo.CountHistory(ctx, orgA, uuidA)
	if err != nil || n != 2 {
		t.Fatalf("history %d %v", n, err)
	}
	changed := []domain.Rating{{Key: "rating_price_green", Name: "价格指数", ValueType: "WEIRD", Status: "BAD", Current: &two}}
	step, err := repo.Apply(ctx, orgA, uuidA, changed, now.Add(2*time.Minute), ranks)
	if err != nil || step.History != 1 || step.Noted != 1 {
		t.Fatalf("change %+v %v", step, err)
	}
	plain := []domain.Rating{{Key: "rating_review", Name: "Оценка", ValueType: "REVIEW_SCORE", Status: "MYSTERY", Current: &one}}
	if _, err := repo.Apply(ctx, orgA, uuidA, plain, now, domain.DefaultRanks()); err != nil {
		t.Fatal(err)
	}
	var status, valueType string
	tx, err := tenantx.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	err = tx.QueryRow(ctx, `
		SELECT status, value_type FROM store_rating_snapshots
		 WHERE org_id = $1 AND store_id = $2::uuid AND rating_key = 'rating_review'`, orgA, uuidA).Scan(&status, &valueType)
	_ = tx.Commit(ctx)
	if err != nil || status != "MYSTERY" || valueType != "REVIEW_SCORE" {
		t.Fatalf("stored %s %s %v", status, valueType, err)
	}

	if _, err := repo.Apply(ctx, orgA, uuidA, []domain.Rating{{
		Key: "rating_secret", Name: secret, Status: "OK", ValueType: "RATIO", Current: &one,
	}}, now, ranks); err == nil {
		t.Fatal("secret field was stored")
	}
	var leaked int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM store_rating_snapshots WHERE name LIKE '%' || $1 || '%'
		    OR rating_key LIKE '%' || $1 || '%'`, secret).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("leaked rows %d %v", leaked, err)
	}

	other, err := tenantx.BeginApp(ctx, pool.Begin, orgB)
	if err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := other.QueryRow(ctx, `SELECT count(*) FROM store_rating_snapshots WHERE rating_key = 'rating_price_green'`).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("org B sees %d %v", seen, err)
	}
	tag, err := other.Exec(ctx, `UPDATE store_rating_snapshots SET name = 'stolen' WHERE org_id = $1`, orgA)
	if err != nil || tag.RowsAffected() != 0 {
		t.Fatalf("org B updated %d %v", tag.RowsAffected(), err)
	}
	if _, err := other.Exec(ctx, `
		INSERT INTO store_rating_snapshots
		    (org_id, store_id, rating_key, name, value_type, status, synced_at)
		VALUES ($1, $2::uuid, 'rating_x', '', '', 'UNKNOWN', $3)`, orgA, uuidA, now); err == nil {
		t.Fatal("org B inserted org A")
	}
	_ = other.Rollback(ctx)
	if err := MissingGUC(ctx, pool, orgA, uuidA); err != nil {
		t.Fatal(err)
	}

	var notes int
	var payload string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(payload::text), '')
		  FROM notifications WHERE user_id = $1 AND kind = 'store_rating_worsened'`, userA).Scan(&notes, &payload); err != nil || notes != 1 {
		t.Fatalf("notes %d %v", notes, err)
	}
	if strings.Contains(payload, secret) || strings.Contains(payload, "fixture-client") {
		t.Fatal("notification payload contains a secret")
	}
	if !strings.Contains(payload, `"fromStatus": "OK"`) || !strings.Contains(payload, `"toStatus": "BAD"`) {
		t.Fatalf("payload %s", payload)
	}

	if _, err := pool.Exec(ctx, `
		UPDATE store_rating_history SET recorded_at = $2
		 WHERE org_id = $1 AND rating_key = 'rating_delivery_complaints_fbo'`, orgA, now.Add(-100*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	deleted, err := repo.Prune(ctx, now.Add(-90*24*time.Hour))
	if err != nil || deleted < 1 {
		t.Fatalf("prune %d %v", deleted, err)
	}
	var oldLeft, freshLeft int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE rating_key = 'rating_delivery_complaints_fbo'),
		       count(*) FILTER (WHERE rating_key = 'rating_price_green')
		  FROM store_rating_history WHERE org_id = $1`, orgA).Scan(&oldLeft, &freshLeft); err != nil {
		t.Fatal(err)
	}
	if oldLeft != 0 || freshLeft < 2 {
		t.Fatalf("after prune old %d fresh %d", oldLeft, freshLeft)
	}
	cross, err := tenantx.BeginApp(ctx, pool.Begin, orgB)
	if err != nil {
		t.Fatal(err)
	}
	tag, err = cross.Exec(ctx, `DELETE FROM store_rating_history WHERE org_id = $1`, orgA)
	if err != nil || tag.RowsAffected() != 0 {
		t.Fatalf("org B deleted %d %v", tag.RowsAffected(), err)
	}
	_ = cross.Rollback(ctx)

	svc := ratingsvc.New(repo)
	r := chi.NewRouter()
	ratinghttp.Mount(r, ratinghttp.Deps{Access: access.FixedResolver{Principal: &access.Principal{
		UserID: userA, OrgID: orgA, WorkspaceRole: "owner",
	}}, Svc: svc})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/"+uuidA+"/ratings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, secret) {
		t.Fatal("response contains a secret")
	}
	wantUnknown := `"ratingKey":"rating_delivery_complaints_fbo","name":"Жалобы по FBO","valueType":"RATIO","status":"UNKNOWN","currentValue":null,"pastValue":null,"noData":true,"direction":"no_data"`
	if !strings.Contains(body, wantUnknown) {
		t.Fatalf("missing no-data marker %s", body)
	}
	if strings.Contains(body, `"status":"UNKNOWN","currentValue":0`) {
		t.Fatal("unknown rendered as zero")
	}
	wantBad := `"ratingKey":"rating_price_green","name":"价格指数","valueType":"WEIRD","status":"BAD","currentValue":2,"pastValue":null,"noData":false,"direction":"up"`
	if !strings.Contains(body, wantBad) {
		t.Fatalf("missing direction %s", body)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/"+uuidB+"/ratings", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross org %d %s", rec.Code, rec.Body.String())
	}
	viewer := chi.NewRouter()
	ratinghttp.Mount(viewer, ratinghttp.Deps{Access: access.FixedResolver{Principal: &access.Principal{
		UserID: userV, OrgID: orgA, WorkspaceRole: "member",
	}}, Svc: svc})
	rec = httptest.NewRecorder()
	viewer.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/"+uuidA+"/ratings", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("viewer %d %s", rec.Code, rec.Body.String())
	}
	if _, err := pool.Exec(ctx, `UPDATE organization_stores SET assignee_membership_id = $1 WHERE uuid = $2`, memberV, uuidA); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	viewer.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/"+uuidA+"/ratings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("assignee %d %s", rec.Code, rec.Body.String())
	}

	if _, err := pool.Exec(ctx, `UPDATE organization_stores SET deleted_at_ms = 1 WHERE uuid = $1`, uuidB); err != nil {
		t.Fatal(err)
	}
	var idA int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid = $1`, uuidA).Scan(&idA); err != nil {
		t.Fatal(err)
	}
	slots := 2
	bucket := domain.StoreBucket(idA, slots)
	due, err := repo.ClaimDue(ctx, now, time.Hour, slots, bucket, 1000)
	if err != nil {
		t.Fatal(err)
	}
	sawA := false
	for _, row := range due {
		if row.StoreID == uuidB {
			t.Fatalf("deleted store claimed %+v", row)
		}
		var id int64
		if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid = $1`, row.StoreID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if domain.StoreBucket(id, slots) != bucket {
			t.Fatalf("store %d not in bucket %d", id, bucket)
		}
		if row.StoreID == uuidA {
			sawA = true
		}
	}
	if !sawA {
		t.Fatal("due store was not claimed")
	}
	againDue, err := repo.ClaimDue(ctx, now, time.Hour, slots, bucket, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range againDue {
		if row.StoreID == uuidA {
			t.Fatalf("lease not held %+v", row)
		}
	}
	if err := repo.Finish(ctx, orgA, uuidA, now, true); err != nil {
		t.Fatal(err)
	}
	held, err := repo.ClaimDue(ctx, now.Add(time.Minute), time.Hour, slots, bucket, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range held {
		if row.StoreID == uuidA {
			t.Fatal("fresh sync was claimed again")
		}
	}
}

func seedRatingOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) (orgID, storeID int64, storeUUID string) {
	t.Helper()
	t.Cleanup(func() {
		if orgID != 0 {
			dropRatingOrg(context.Background(), pool, orgID, userID)
		}
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, fmt.Sprintf("rt%d", userID), fmt.Sprintf("rt%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`,
		userID, "rt-"+tag).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name)
		VALUES ($1, 1, $2) RETURNING id, uuid::text`, orgID, "store-"+tag).Scan(&storeID, &storeUUID); err != nil {
		t.Fatal(err)
	}
	return orgID, storeID, storeUUID
}

func addMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, role string, order int) int64 {
	t.Helper()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM organization_members WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM account_users WHERE id = $1`, userID)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, fmt.Sprintf("rt%d", userID), fmt.Sprintf("rt%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, $3, 'active', 't', clock_timestamp(), clock_timestamp(), $4) RETURNING id`,
		orgID, userID, role, order).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func dropRatingOrg(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM notifications WHERE user_id = $1`, userID)
	_, _ = pool.Exec(ctx, `DELETE FROM store_rating_history WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM store_rating_snapshots WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM store_rating_sync WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_members WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = $1`, userID)
}

var (
	parityOnce sync.Once
	parityPool *pgxpool.Pool
	parityErr  error
)

func parityDB(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	parityOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				parityErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				parityErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			parityErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			parityErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			parityErr = err
			return
		}
		parityPool = pool
	})
	if parityErr != nil {
		t.Fatal(parityErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return parityPool, ctx
}
