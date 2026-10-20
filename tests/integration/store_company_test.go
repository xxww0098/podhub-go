package integration

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	dbschema "github.com/xxww0098/podhub-go/db"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/seller"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
	storehttp "github.com/xxww0098/podhub-go/internal/store/http"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

const (
	storeFixtureKey = "fixture-api-key-store-autofill"
	storeTaxINN     = "tax-inn-must-not-leak"
	storeTaxOGRN    = "tax-ogrn-must-not-leak"
	storeTaxSystem  = "tax-system-must-not-leak"
	storeOwnership  = "ownership-form-must-not-leak"
)

func TestStoreCompanyAutofillAndGroups(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	testkit.CompareHeadFingerprint(t, ctx, pool)

	ownerA := int64(97101)
	opA := int64(97102)
	ownerB := int64(97103)
	orgA := seedCompanyOrg(t, ctx, pool, ownerA, "a")
	orgB := seedCompanyOrg(t, ctx, pool, ownerB, "b")
	memberOp := seedCompanyMember(t, ctx, pool, orgA, opA, "member", 2)
	seedCompanyMember(t, ctx, pool, orgA, ownerA, "owner", 1)
	seedCompanyMember(t, ctx, pool, orgB, ownerB, "owner", 1)

	idAuto := "00000000-0000-4000-8000-000000000001"
	idManual := "00000000-0000-4000-8000-000000000002"
	idLoose := "00000000-0000-4000-8000-000000000003"
	idPlain := "00000000-0000-4000-8000-000000000004"
	idBranch := "00000000-0000-4000-8000-000000000005"
	idOther := "00000000-0000-4000-8000-000000000006"
	seedCompanyStore(t, ctx, pool, orgA, idAuto, 1, "old", nil)
	seedCompanyStore(t, ctx, pool, orgA, idManual, 2, "handmade", nil)
	if _, err := pool.Exec(ctx, `UPDATE organization_stores SET name_source = 'manual' WHERE uuid = $1::uuid`, idManual); err != nil {
		t.Fatal(err)
	}
	seedCompanyStore(t, ctx, pool, orgA, idLoose, 3, "loose", nil)
	seedCompanyStore(t, ctx, pool, orgA, idPlain, 4, "plain", nil)
	seedCompanyStore(t, ctx, pool, orgA, idBranch, 5, "branch", &memberOp)
	seedCompanyStore(t, ctx, pool, orgB, idOther, 1, "other-org", nil)

	var mode atomic.Value
	mode.Store("full")
	var seenKey atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Api-Key") == storeFixtureKey {
			seenKey.Add(1)
		}
		if r.URL.Path != "/v1/seller/info" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		switch mode.Load() {
		case "fail":
			http.Error(w, storeTaxINN+storeTaxSystem, http.StatusInternalServerError)
		case "denied":
			http.Error(w, storeFixtureKey+storeTaxOGRN+storeOwnership, http.StatusUnauthorized)
		case "missing":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"subscription":{"is_premium":false,"type":"FREE"},"ratings":[]}`))
		case "other":
			_, _ = w.Write([]byte(`{"company":{"name":"BRANCH","legal_name":"Other Co","currency":"CNY"}}`))
		default:
			_, _ = w.Write([]byte(`{"company":{"name":"LUAN4","legal_name":"Sanming Lu an Fire Equipment Co., Ltd.","ownership_form":"` + storeOwnership + `","inn":"` + storeTaxINN + `","ogrn":"` + storeTaxOGRN + `","tax_system":"` + storeTaxSystem + `","currency":"CNY","country":"CN"},"subscription":{"is_premium":false,"type":"FREE"},"ratings":[{"value":1}]}`))
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")

	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	eg := seller.New(config.Load()).WithPool(pool)
	kek := seal.DeriveKEK("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	directory := storerepo.New(pool, tenantx.BeginApp).WithSeal(seal.Ring{Primary: kek}, true)
	svc := storesvc.New(directory, loopSeller{eg}).WithCredential(directory)

	filled, err := svc.OnCredentialSaved(ctx, orgA, idAuto, "client-fixture", storeFixtureKey)
	if err != nil || !filled.Filled || filled.Name != "LUAN4" || filled.Source != domain.SourceAuto {
		t.Fatalf("autofill %+v %v", filled, err)
	}
	assertStore(t, ctx, pool, idAuto, "LUAN4", "LUAN4", "Sanming Lu an Fire Equipment Co., Ltd.", domain.SourceAuto)
	assertSeller(t, ctx, pool, idAuto, "CNY", "CN", "FREE", domain.KeyValid, "", boolPtr(false), true)

	if _, err := pool.Exec(ctx, `
		INSERT INTO store_product_sync (org_id, store_id, refresh_generation, currency)
		VALUES ($1, $2::uuid, 1, 'USD')`, orgA, idManual); err != nil {
		t.Fatal(err)
	}
	manual, err := svc.OnCredentialVerified(ctx, orgA, idManual, "client-fixture", storeFixtureKey)
	if err != nil || manual.Filled || manual.Name != "handmade" || manual.Source != domain.SourceManual || !manual.CurrencyMismatch || manual.CurrencyWarning != "公司币种 CNY 与店铺定价币种 USD 不一致" {
		t.Fatalf("manual %+v %v", manual, err)
	}
	assertStore(t, ctx, pool, idManual, "handmade", "LUAN4", "Sanming Lu an Fire Equipment Co., Ltd.", domain.SourceManual)
	assertSeller(t, ctx, pool, idManual, "CNY", "CN", "FREE", domain.KeyValid, "", boolPtr(false), true)

	mode.Store("fail")
	failed, err := svc.OnCredentialSaved(ctx, orgA, idLoose, "client-fixture", storeFixtureKey)
	if err != nil || !failed.UpstreamFailed || failed.Name != "loose" {
		t.Fatalf("fail %+v %v", failed, err)
	}
	assertStore(t, ctx, pool, idLoose, "loose", "", "", domain.SourceAuto)
	assertSeller(t, ctx, pool, idLoose, "", "", "", domain.KeyUnknown, domain.ReasonUpstream, nil, false)

	mode.Store("missing")
	skipped, err := svc.OnCredentialVerified(ctx, orgA, idPlain, "client-fixture", storeFixtureKey)
	if err != nil || skipped.UpstreamFailed || skipped.Filled || skipped.Name != "plain" {
		t.Fatalf("missing %+v %v", skipped, err)
	}
	assertStore(t, ctx, pool, idPlain, "plain", "", "", domain.SourceAuto)
	assertSeller(t, ctx, pool, idPlain, "", "", "FREE", domain.KeyValid, "", boolPtr(false), true)

	mode.Store("other")
	if _, err := svc.OnCredentialSaved(ctx, orgA, idBranch, "client-fixture", storeFixtureKey); err != nil {
		t.Fatal(err)
	}
	assertStore(t, ctx, pool, idBranch, "BRANCH", "BRANCH", "Other Co", domain.SourceAuto)

	if _, err := directory.Load(ctx, orgA, idOther); err != contract.ErrNotFound {
		t.Fatal(err)
	}
	assertStore(t, ctx, pool, idOther, "other-org", "", "", domain.SourceAuto)

	same, err := svc.Rename(ctx, orgA, ownerA, "owner", idAuto, " LUAN4 ")
	if err != nil || same.Name != "LUAN4" || same.Source != domain.SourceAuto {
		t.Fatalf("same %+v %v", same, err)
	}
	renamed, err := svc.Rename(ctx, orgA, ownerA, "owner", idAuto, "handmade-shop")
	if err != nil || renamed.Name != "handmade-shop" || renamed.Source != domain.SourceManual {
		t.Fatalf("rename %+v %v", renamed, err)
	}
	assertStore(t, ctx, pool, idAuto, "handmade-shop", "LUAN4", "Sanming Lu an Fire Equipment Co., Ltd.", domain.SourceManual)
	if _, err := svc.Rename(ctx, orgA, opA, "member", idBranch, "nope"); err != contract.ErrForbidden {
		t.Fatal(err)
	}

	groups, err := svc.Groups(ctx, orgA, ownerA, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 || groups[0].Name != "Other Co" || groups[0].Stores[0].UUID != idBranch {
		t.Fatalf("groups %+v", groups)
	}
	if groups[1].Name != "Sanming Lu an Fire Equipment Co., Ltd." || len(groups[1].Stores) != 2 {
		t.Fatalf("legal %+v", groups[1])
	}
	if groups[2].Name != domain.Unclassified || len(groups[2].Stores) != 2 {
		t.Fatalf("unclassified %+v", groups[2])
	}
	opGroups, err := svc.Groups(ctx, orgA, opA, "member")
	if err != nil || len(opGroups) != 1 || len(opGroups[0].Stores) != 1 || opGroups[0].Stores[0].UUID != idBranch {
		t.Fatalf("operator %+v %v", opGroups, err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := (storerepo.Repo{}).RefuseUnsetOrg(ctx, tx); err != contract.ErrNoTenant {
		t.Fatal(err)
	}
	bare := storerepo.New(pool, func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), _ int64) (pgx.Tx, error) {
		return begin(ctx)
	})
	if _, err := bare.Load(ctx, orgA, idLoose); err != contract.ErrNoTenant {
		t.Fatal(err)
	}
	assertStore(t, ctx, pool, idLoose, "loose", "", "", domain.SourceAuto)

	mode.Store("denied")
	denied, err := svc.OnCredentialSaved(ctx, orgA, idLoose, "client-fixture", storeFixtureKey)
	if err != nil || !denied.UpstreamFailed || denied.Name != "loose" {
		t.Fatalf("denied %+v %v", denied, err)
	}
	assertSeller(t, ctx, pool, idLoose, "", "", "", domain.KeyInvalid, domain.Reason401, nil, false)

	t.Setenv("CLOUD_SELLER_BASE_URL", "http://127.0.0.1:1")
	offline := seller.New(config.Load())
	netSvc := storesvc.New(directory, loopSeller{offline})
	networked, err := netSvc.OnCredentialVerified(ctx, orgA, idPlain, "client-fixture", storeFixtureKey)
	if err != nil || !networked.UpstreamFailed || networked.Name != "plain" {
		t.Fatalf("network %+v %v", networked, err)
	}
	assertSeller(t, ctx, pool, idPlain, "", "", "FREE", domain.KeyUnknown, domain.ReasonNetwork, boolPtr(false), true)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")

	var branchID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid = $1::uuid`, idBranch).Scan(&branchID); err != nil {
		t.Fatal(err)
	}
	env, err := seal.SealV1(kek, "k-store", "client-fixture", storeFixtureKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_seller_credentials (
			store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
			key_fingerprint, registered_by_user_id, registered_at_ms)
		VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, 1)`,
		branchID, orgA, env.ClientID, env.KeyID, env.Nonce, env.Ciphertext, env.Fingerprint, ownerA); err != nil {
		t.Fatal(err)
	}
	mode.Store("other")
	refreshed, warning, err := svc.Refresh(ctx, orgA, ownerA, "owner", idBranch)
	if err != nil || refreshed.Name != "BRANCH" || refreshed.KeyStatus != domain.KeyValid || warning != "" {
		t.Fatalf("refresh %+v %s %v", refreshed, warning, err)
	}
	if _, _, err := svc.Refresh(ctx, orgB, ownerB, "owner", idBranch); err != contract.ErrNotFound {
		t.Fatal(err)
	}
	if _, _, err := svc.Refresh(ctx, orgA, opA, "member", idBranch); err != contract.ErrForbidden {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	storehttp.Mount(router, storehttp.Deps{
		Resolve: func(*http.Request) (*storehttp.Session, *storehttp.Refusal, error) {
			return &storehttp.Session{UserID: ownerA, OrgID: orgA, WorkspaceRole: "owner"}, nil, nil
		},
		Actions: svc,
	})
	refreshRec := httptest.NewRecorder()
	refreshReq := httptest.NewRequest(http.MethodPost, "/api/workspaces/stores/"+idBranch+"/seller-info", strings.NewReader(`{}`))
	refreshReq.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(refreshRec, refreshReq)
	if refreshRec.Code != http.StatusOK || strings.Contains(refreshRec.Body.String(), storeFixtureKey) {
		t.Fatalf("refresh http %d %s", refreshRec.Code, refreshRec.Body.String())
	}

	handler := app.Handler(pool)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/billing/usage-stats", nil))
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), storeFixtureKey) {
		t.Fatalf("anon %d %s", rec.Code, rec.Body.String())
	}

	text := logs.String()
	var stored string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(string_agg(s::text, ''), '') FROM public.organization_stores s`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var audits string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(string_agg(a::text, ''), '') FROM public.audit_logs a`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	responses := rec.Body.String() + refreshRec.Body.String()
	for _, leak := range []string{storeFixtureKey, storeTaxINN, storeTaxOGRN, storeTaxSystem, storeOwnership, `"inn"`, `"ogrn"`, `"tax_system"`, `"ownership_form"`, `"ratings"`} {
		if strings.Contains(text, leak) || strings.Contains(stored, leak) || strings.Contains(audits, leak) || strings.Contains(responses, leak) {
			t.Fatalf("leak %s log=%t row=%t audit=%t resp=%t", leak, strings.Contains(text, leak), strings.Contains(stored, leak), strings.Contains(audits, leak), strings.Contains(responses, leak))
		}
	}
	if seenKey.Load() == 0 || eg.WritePosts() != 0 || eg.ReadPosts() == 0 {
		t.Fatalf("seen %d writes %d reads %d", seenKey.Load(), eg.WritePosts(), eg.ReadPosts())
	}
}

// TestExistingStoreNameBecomesManual applies 00329, inserts a row, then
// continues. The shared template is already at head, so this test keeps an
// empty private cluster.
func TestExistingStoreNameBecomesManual(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	dsn, cleanup, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	goose.SetBaseFS(dbschema.Migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { sqlDB.Close() })
	if err := goose.UpToContext(ctx, sqlDB, "migrations", 329); err != nil {
		t.Fatal(err)
	}

	owner := int64(97201)
	orgID := seedCompanyOrg(t, ctx, pool, owner, "kept")
	idKept := "00000000-0000-4000-8000-0000000000a1"
	seedCompanyStore(t, ctx, pool, orgID, idKept, 1, "kept-shop", nil)
	if err := goose.UpToContext(ctx, sqlDB, "migrations", 331); err != nil {
		t.Fatal(err)
	}
	assertStore(t, ctx, pool, idKept, "kept-shop", "", "", domain.SourceAuto)
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		t.Fatal(err)
	}
	var applied int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = 332 AND is_applied`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != 1 {
		t.Fatalf("00332 applied %d", applied)
	}
	assertStore(t, ctx, pool, idKept, "kept-shop", "", "", domain.SourceManual)

	idNew := "00000000-0000-4000-8000-0000000000a2"
	seedCompanyStore(t, ctx, pool, orgID, idNew, 2, "new-shop", nil)
	assertStore(t, ctx, pool, idNew, "new-shop", "", "", domain.SourceAuto)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"company":{"name":"LUAN4","legal_name":"Co","currency":"CNY"}}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	eg := seller.New(config.Load())
	svc := storesvc.New(storerepo.New(pool, tenantx.BeginApp), loopSeller{eg})
	kept, err := svc.OnCredentialSaved(ctx, orgID, idKept, "client-fixture", storeFixtureKey)
	if err != nil || kept.Filled || kept.Name != "kept-shop" || kept.Source != domain.SourceManual {
		t.Fatalf("kept %+v %v", kept, err)
	}
	filled, err := svc.OnCredentialSaved(ctx, orgID, idNew, "client-fixture", storeFixtureKey)
	if err != nil || !filled.Filled || filled.Name != "LUAN4" || filled.Source != domain.SourceAuto {
		t.Fatalf("new %+v %v", filled, err)
	}
	assertStore(t, ctx, pool, idKept, "kept-shop", "LUAN4", "Co", domain.SourceManual)
	assertStore(t, ctx, pool, idNew, "LUAN4", "LUAN4", "Co", domain.SourceAuto)
	if eg.WritePosts() != 0 {
		t.Fatalf("writes %d", eg.WritePosts())
	}
}

type loopSeller struct{ eg *seller.Egress }

func (c loopSeller) PostSellerInfo(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	reply, err := c.eg.Call(ctx, http.MethodPost, "/v1/seller/info", []byte(`{}`), false, false, clientID, apiKey)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

func seedCompanyOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 'Store', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, "st"+tag, tag+"@store.example.invalid"); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`,
		userID, "org-"+tag).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	return orgID
}

func seedCompanyMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, role string, order int) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, $3, 'active', $3, clock_timestamp(), clock_timestamp(), $4) RETURNING id`,
		orgID, userID, role, order).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedCompanyStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, id string, order int, name string, assignee *int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_stores (org_id, uuid, create_order, name, assignee_membership_id)
		VALUES ($1, $2::uuid, $3, $4, $5)`, orgID, id, order, name, assignee); err != nil {
		t.Fatal(err)
	}
}

func assertStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, name, short, legal, source string) {
	t.Helper()
	var gotName, gotShort, gotLegal, gotSource string
	if err := pool.QueryRow(ctx, `
		SELECT name, COALESCE(company_short_name, ''), COALESCE(company_legal_name, ''), name_source
		  FROM organization_stores WHERE uuid = $1::uuid`, id).Scan(&gotName, &gotShort, &gotLegal, &gotSource); err != nil {
		t.Fatal(err)
	}
	if gotName != name || gotShort != short || gotLegal != legal || gotSource != source {
		t.Fatalf("store %s got %s/%s/%s/%s", id, gotName, gotShort, gotLegal, gotSource)
	}
}

func assertSeller(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, currency, country, subType, status, reason string, premium *bool, synced bool) {
	t.Helper()
	var gotCurrency, gotCountry, gotType, gotStatus, gotReason string
	var gotPremium *bool
	var gotSynced *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(company_currency, ''), COALESCE(company_country, ''),
		       subscription_is_premium, COALESCE(subscription_type, ''),
		       seller_info_synced_at, seller_key_status, COALESCE(seller_key_reason, '')
		  FROM organization_stores WHERE uuid = $1::uuid`, id).Scan(
		&gotCurrency, &gotCountry, &gotPremium, &gotType, &gotSynced, &gotStatus, &gotReason); err != nil {
		t.Fatal(err)
	}
	if gotCurrency != currency || gotCountry != country || gotType != subType || gotStatus != status || gotReason != reason || (gotSynced != nil) != synced {
		t.Fatalf("seller %s got %s/%s/%s/%s/%s synced %v", id, gotCurrency, gotCountry, gotType, gotStatus, gotReason, gotSynced != nil)
	}
	if (premium == nil) != (gotPremium == nil) || (premium != nil && *premium != *gotPremium) {
		t.Fatalf("premium %v got %v", premium, gotPremium)
	}
}

func boolPtr(v bool) *bool { return &v }
