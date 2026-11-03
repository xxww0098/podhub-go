package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	adminservice "github.com/xxww0098/podhub-go/internal/admin/service"
	x1repo "github.com/xxww0098/podhub-go/internal/admin/x1/repo"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
	catalogrepo "github.com/xxww0098/podhub-go/internal/suppliercatalog/repo"
)

type supplierCatalogHTTPFixture struct {
	ctx                context.Context
	pool, api          *pgxpool.Pool
	server             *httptest.Server
	managerA, managerB int64
	sourceA, sourceB   string
	cookieA, cookieB   string
}

type supplierCatalogReply struct {
	status int
	body   []byte
}

func newSupplierCatalogHTTPFixture(t *testing.T) supplierCatalogHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_PARITY_DSN", dsn)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	pool := migratedPool(t, ctx)
	a, sourceA := seedCatalogManager(t, ctx, pool, 97931, "http-a")
	b, sourceB := seedCatalogManager(t, ctx, pool, 97932, "http-b")
	hash, err := bcrypt.GenerateFromPassword([]byte("supplier-catalog-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_users SET password_hash=$1 WHERE id=ANY($2::bigint[])`, string(hash), []int64{a, b}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-supplier-catalog'`); err != nil {
		t.Fatal(err)
	}
	// The concurrency regression holds one fixture connection and observes it
	// from another. Open both before disabling the fixture-only login override.
	first, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := pool.Acquire(ctx)
	first.Release()
	if err != nil {
		t.Fatal(err)
	}
	second.Release()
	u, err := url.Parse(swapUser(dsn, "podhub_login_api", "isolated-supplier-catalog"))
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("pool_max_conns", "1")
	u.RawQuery = query.Encode()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	api, err := db.Connect(ctx, config.Config{DatabaseURL: u.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	f := supplierCatalogHTTPFixture{ctx: ctx, pool: pool, api: api, managerA: a, managerB: b, sourceA: sourceA, sourceB: sourceB}
	f.assertRole(t)
	if _, err := api.Exec(ctx, `SELECT product_id FROM sc_products LIMIT 1`); err == nil {
		t.Fatal("NOINHERIT login unexpectedly has direct catalog access")
	} else if pg, ok := err.(*pgconn.PgError); !ok || pg.Code != "42501" {
		t.Fatalf("expected direct-query permission denial: %v", err)
	}
	f.server = httptest.NewServer(app.Handler(api))
	t.Cleanup(f.server.Close)
	login := func(email string) string {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, f.server.URL+"/api/auth/login", strings.NewReader(`{"email":"`+email+`","password":"supplier-catalog-password"}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "supplier-catalog-"+email)
		response, err := f.server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("production-role login failed: %d %s", response.StatusCode, body)
		}
		for _, cookie := range response.Cookies() {
			if cookie.Name == "sid" {
				return cookie.Name + "=" + cookie.Value
			}
		}
		t.Fatal("login returned no session cookie")
		return ""
	}
	f.cookieA = login("sccat-http-a@test.example")
	f.cookieB = login("sccat-http-b@test.example")
	return f
}

func (f supplierCatalogHTTPFixture) request(method, path, cookie, body string) (supplierCatalogReply, error) {
	request, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		return supplierCatalogReply{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	response, err := f.server.Client().Do(request)
	if err != nil {
		return supplierCatalogReply{}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	return supplierCatalogReply{status: response.StatusCode, body: raw}, err
}

func (f supplierCatalogHTTPFixture) call(t *testing.T, method, path, cookie, body string, want int) []byte {
	t.Helper()
	reply, err := f.request(method, path, cookie, body)
	if err != nil || reply.status != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s err=%v", method, path, reply.status, want, reply.body, err)
	}
	return reply.body
}

func (f supplierCatalogHTTPFixture) assertRole(t *testing.T) {
	t.Helper()
	var current, session, org, staff, manager string
	var super, inherit, bypass bool
	if err := f.api.QueryRow(f.ctx, `SELECT current_user,session_user,rolsuper,rolinherit,rolbypassrls,
		COALESCE(current_setting('app.current_org_id',true),''),COALESCE(current_setting('app.staff_access',true),''),
		COALESCE(current_setting('app.current_org_user_id',true),'') FROM pg_roles WHERE rolname=current_user`).Scan(
		&current, &session, &super, &inherit, &bypass, &org, &staff, &manager); err != nil {
		t.Fatal(err)
	}
	if current != "podhub_login_api" || session != current || super || inherit || bypass || org != "" || staff != "" || manager != "" {
		t.Fatalf("unsafe or leaked catalog connection: current=%s session=%s super=%v inherit=%v bypass=%v org=%q staff=%q manager=%q", current, session, super, inherit, bypass, org, staff, manager)
	}
}

func supplierCatalogRow(t *testing.T, raw []byte) contract.CatalogRow {
	t.Helper()
	var row contract.CatalogRow
	if err := json.Unmarshal(raw, &row); err != nil || row.ProductID == "" {
		t.Fatalf("invalid catalog row: %s err=%v", raw, err)
	}
	return row
}

func (f supplierCatalogHTTPFixture) ready(t *testing.T, row contract.CatalogRow) {
	t.Helper()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE sc_products SET description_category_id=1,type_id=2,gallery='[{"url":"https://cdn.example/image.jpg","w":10,"h":10}]' WHERE product_id=$1`, []any{row.ProductID}},
		{`INSERT INTO ozon_category_current(description_category_id,type_id,language,fields,content_digest,fetched_at_ms)
			VALUES(1,2,'default','[]','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',(extract(epoch FROM clock_timestamp())*1000)::bigint) ON CONFLICT DO NOTHING`, nil},
		{`INSERT INTO supplier_ozon_configs (product_id,description_category_id,type_id,prompt_text,fixed_tags,state,validated_catalog_digest,created_at_ms,updated_at_ms,created_by_account_uuid,updated_by_account_uuid)
			VALUES ($1,1,2,'fixture','["#тег"]','valid','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,'fixture','fixture')`, []any{row.ProductID}},
		{`INSERT INTO sc_price_versions (sku_id,price_cents,created_at_ms,created_by_account_uuid) VALUES ($1,1000,1,'fixture')`, []any{row.SKUID}},
	} {
		if _, err := f.pool.Exec(f.ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSupplierCatalogProductionRoleHTTP(t *testing.T) {
	f := newSupplierCatalogHTTPFixture(t)
	base := "/api/supplier-catalog/sources/" + f.sourceA
	f.call(t, http.MethodGet, "/api/supplier-catalog/sources", "", "", http.StatusUnauthorized)
	var sources contract.SourceListData
	if err := json.Unmarshal(f.call(t, http.MethodGet, "/api/supplier-catalog/sources", f.cookieA, "", http.StatusOK), &sources); err != nil || len(sources.Sources) != 1 || sources.Sources[0].SourceID != f.sourceA {
		t.Fatalf("source isolation failed: %+v err=%v", sources, err)
	}
	f.call(t, http.MethodGet, base, f.cookieA, "", http.StatusOK)
	f.call(t, http.MethodGet, base+"/rows", f.cookieA, "", http.StatusOK)
	row := supplierCatalogRow(t, f.call(t, http.MethodPost, base+"/rows", f.cookieA, `{"title":"First","platformCode":"http-code","costCents":300,"shippingCostCents":40}`, http.StatusCreated))
	path := base + "/rows/" + row.ProductID
	row = supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
	if row.CostCents == nil || *row.CostCents != 300 || row.ShippingCostCents == nil || *row.ShippingCostCents != 40 {
		t.Fatalf("catalog cost did not round trip: %+v", row)
	}
	row = supplierCatalogRow(t, f.call(t, http.MethodPut, path, f.cookieA, `{"title":"Changed","platformCode":"http-code","costCents":400,"shippingCostCents":50,"revision":1}`, http.StatusOK))
	if row.Revision != 2 || row.Title != "Changed" || row.CostCents == nil || *row.CostCents != 400 {
		t.Fatalf("row update did not persist: %+v", row)
	}
	f.call(t, http.MethodPut, path, f.cookieA, `{"title":"Stale","platformCode":"http-code","revision":1}`, http.StatusConflict)
	f.call(t, http.MethodPut, path, f.cookieA, `{"title":"Forbidden price","platformPriceCents":1,"revision":2}`, http.StatusBadRequest)
	f.call(t, http.MethodPost, path+"/publish", f.cookieA, "", http.StatusForbidden)
	f.call(t, http.MethodPost, path+"/unpublish", f.cookieA, "", http.StatusForbidden)
	if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, f.managerA); err != nil {
		t.Fatal(err)
	}
	f.ready(t, row)
	if _, err := f.pool.Exec(f.ctx, `UPDATE sc_products SET gallery='[]' WHERE product_id=$1`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	var missing struct {
		Missing []string `json:"missing"`
	}
	if err := json.Unmarshal(f.call(t, http.MethodPost, path+"/publish", f.cookieA, "", http.StatusBadRequest), &missing); err != nil || len(missing.Missing) != 1 || missing.Missing[0] != "gallery" {
		t.Fatalf("empty gallery must prevent publishing: %+v err=%v", missing, err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE sc_products SET gallery='[{"url":"https://cdn.example/image.jpg","w":10,"h":10}]' WHERE product_id=$1`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE supplier_ozon_configs SET state='needs_reconfiguration' WHERE product_id=$1`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(f.call(t, http.MethodPost, path+"/publish", f.cookieA, "", http.StatusBadRequest), &missing); err != nil || len(missing.Missing) != 1 || missing.Missing[0] != "ozonConfig" {
		t.Fatalf("unvalidated Ozon config must prevent publishing: %+v err=%v", missing, err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE supplier_ozon_configs SET state='valid' WHERE product_id=$1`, row.ProductID); err != nil {
		t.Fatal(err)
	}
	row = supplierCatalogRow(t, f.call(t, http.MethodPost, path+"/publish", f.cookieA, "", http.StatusOK))
	if !row.Published {
		t.Fatal("ready row did not publish")
	}
	if err := json.Unmarshal(f.call(t, http.MethodPut, path, f.cookieA, fmt.Sprintf(`{"title":"No image","platformCode":"http-code","gallery":[],"revision":%d}`, row.Revision), http.StatusBadRequest), &missing); err != nil || len(missing.Missing) != 1 || missing.Missing[0] != "gallery" {
		t.Fatalf("published gallery removal must be refused: %+v err=%v", missing, err)
	}
	stillPublished := supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
	if !stillPublished.Published || len(stillPublished.Gallery) != 1 || stillPublished.Revision != row.Revision {
		t.Fatalf("refused edit changed published product: %+v", stillPublished)
	}
	row = supplierCatalogRow(t, f.call(t, http.MethodPost, path+"/unpublish", f.cookieA, "", http.StatusOK))
	if row.Published {
		t.Fatal("row did not unpublish")
	}

	t.Run("isolation and revoked grant", func(t *testing.T) {
		for _, action := range []struct{ method, suffix, body string }{
			{http.MethodGet, "", ""}, {http.MethodPut, "", `{"title":"Other","platformCode":"other","revision":4}`},
			{http.MethodPost, "/publish", ""}, {http.MethodPost, "/unpublish", ""}, {http.MethodDelete, "", ""},
		} {
			f.call(t, action.method, path+action.suffix, f.cookieB, action.body, http.StatusForbidden)
		}
		f.call(t, http.MethodPost, base+"/rows", f.cookieB, `{"title":"Other","platformCode":"other","costCents":100}`, http.StatusForbidden)
		if _, err := f.pool.Exec(f.ctx, `UPDATE sc_catalog_managers SET status='disabled',revoked_at_ms=1 WHERE user_id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodGet, base+"/rows", f.cookieA, "", http.StatusForbidden)
		f.call(t, http.MethodPut, path, f.cookieA, `{"title":"Revoked","platformCode":"http-code","revision":4}`, http.StatusForbidden)
		if _, err := f.pool.Exec(f.ctx, `UPDATE sc_catalog_managers SET status='active',revoked_at_ms=NULL WHERE user_id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodGet, base+"/rows", f.cookieA, "", http.StatusUnauthorized)
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		f.assertRole(t)
	})

	t.Run("later write failure rolls back product and sku", func(t *testing.T) {
		before := supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
		if _, err := f.pool.Exec(f.ctx, `CREATE FUNCTION reject_catalog_offer_write() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'injected offer failure'; END $$;
			CREATE TRIGGER reject_catalog_offer_write BEFORE UPDATE ON sc_source_offers FOR EACH ROW EXECUTE FUNCTION reject_catalog_offer_write()`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = f.pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS reject_catalog_offer_write ON sc_source_offers; DROP FUNCTION IF EXISTS reject_catalog_offer_write()`)
		})
		body, _ := json.Marshal(map[string]any{"title": "Must roll back", "platformCode": "changed-code", "costCents": 999, "revision": before.Revision})
		f.call(t, http.MethodPut, path, f.cookieA, string(body), http.StatusInternalServerError)
		after := supplierCatalogRow(t, f.call(t, http.MethodGet, path, f.cookieA, "", http.StatusOK))
		if after.Title != before.Title || after.PlatformCode != before.PlatformCode || after.Revision != before.Revision || after.CostCents == nil || *after.CostCents != *before.CostCents {
			t.Fatalf("failed offer write left partial row: before=%+v after=%+v", before, after)
		}
		f.assertRole(t)
	})
	f.call(t, http.MethodDelete, path, f.cookieA, "", http.StatusNoContent)
	var rows contract.RowListData
	if err := json.Unmarshal(f.call(t, http.MethodGet, base+"/rows", f.cookieA, "", http.StatusOK), &rows); err != nil || len(rows.Rows) != 0 {
		t.Fatalf("archived row remained visible: %+v err=%v", rows, err)
	}
	f.assertRole(t)
}

func TestSupplierRowUploadProductionRoleHTTP(t *testing.T) {
	f := newSupplierCatalogHTTPFixture(t)
	if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='admin' WHERE id=ANY($1::bigint[])`, []int64{f.managerA, f.managerB}); err != nil {
		t.Fatal(err)
	}
	for _, source := range []struct {
		id   string
		user int64
	}{{f.sourceA, f.managerA}, {f.sourceB, f.managerB}} {
		if _, err := f.pool.Exec(f.ctx, `UPDATE sc_sources SET created_by_account_uuid=(SELECT public_id FROM account_users WHERE id=$2) WHERE source_id=$1`, source.id, source.user); err != nil {
			t.Fatal(err)
		}
	}
	seedMatchingLease(t, f.ctx, f.pool, "admin", "supplier row upload integration")

	type storedObject struct {
		body        []byte
		contentType string
		promotion   string
	}
	var storageMu sync.Mutex
	objects := map[string]storedObject{}
	var imagePuts, sidecarPuts, signedReads, publicReads int
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/bucket/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		storageMu.Lock()
		defer storageMu.Unlock()
		switch r.Method {
		case http.MethodPut:
			body, err := io.ReadAll(io.LimitReader(r.Body, 20<<20))
			sum := sha256.Sum256(body)
			contentType := r.Header.Get("Content-Type")
			promotion := r.Header.Get("X-Amz-Meta-Podhub-Upload")
			if err != nil || r.Header.Get("If-None-Match") != "*" || (contentType != "image/png" && contentType != "application/json") ||
				(contentType == "image/png" && promotion == "" && r.Header.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(sum[:])) {
				http.Error(w, "invalid upload headers or checksum", http.StatusBadRequest)
				return
			}
			if _, exists := objects[r.URL.Path]; exists {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			objects[r.URL.Path] = storedObject{body: bytes.Clone(body), contentType: contentType, promotion: promotion}
			if strings.HasSuffix(r.URL.Path, ".verified") {
				sidecarPuts++
			} else {
				imagePuts++
			}
			w.WriteHeader(http.StatusOK)
		case http.MethodGet, http.MethodHead:
			object, exists := objects[r.URL.Path]
			if !exists {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Method == http.MethodGet && !strings.HasSuffix(r.URL.Path, ".verified") {
				if r.URL.Query().Get("X-Amz-Signature") == "" {
					publicReads++
				} else {
					signedReads++
				}
			}
			w.Header().Set("Content-Type", object.contentType)
			w.Header().Set("Content-Length", strconv.Itoa(len(object.body)))
			if object.promotion != "" {
				w.Header().Set("X-Amz-Meta-Podhub-Upload", object.promotion)
			}
			if r.Method == http.MethodGet {
				_, _ = w.Write(object.body)
			}
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(storage.Close)
	account := sign.Account{ID: "supplier-row-test", Provider: sign.ProviderCloudflare, Endpoint: storage.URL, Bucket: "bucket",
		PublicBaseURL: storage.URL + "/bucket", Region: "auto", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test"}
	access := identity.New(f.api)
	router := chi.NewRouter()
	router.Use(identity.CSRF, access.Middleware)
	adminhttp.Mount(router, adminhttp.Deps{
		Resolve: func(r *http.Request) (*adminhttp.Session, *adminhttp.Refusal, error) {
			p, refusal, err := access.Resolve(r)
			if err != nil {
				return nil, nil, err
			}
			if refusal != nil {
				return nil, &adminhttp.Refusal{Status: refusal.Status, Message: refusal.Message}, nil
			}
			if p == nil {
				return nil, nil, nil
			}
			return &adminhttp.Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole,
				PlatformRole: p.PlatformRole, PublicID: p.PublicID, Email: p.Email, TokenHash: p.TokenHash}, nil, nil
		},
		Supplier: &adminservice.Service{
			Cat: x1repo.NewX1(f.api, tenantx.BeginApp), Origin: adminhttp.R2Origin{}, Now: time.Now,
			CatalogAccess: catalogrepo.Repo{Pool: f.api},
			Accounts:      func(context.Context) (sign.Account, bool, error) { return account, true, nil },
		},
	})
	f.server = httptest.NewServer(router)
	t.Cleanup(f.server.Close)
	base := "/api/admin/supplier-dbs/" + f.sourceA
	f.call(t, http.MethodGet, base, f.cookieB, "", http.StatusNotFound)

	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	img.SetRGBA(3, 4, color.RGBA{R: 180, G: 90, B: 30, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	imageBytes := encoded.Bytes()
	digest := sha256.Sum256(imageBytes)
	body, err := json.Marshal(map[string]any{"kind": "gallery", "filename": "商品.png", "content_type": "image/png", "bytes": len(imageBytes), "sha256": hex.EncodeToString(digest[:])})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+base+"/uploads", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", f.cookieA)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Podhub-Store-Checksum", "sha256")
	response, err := f.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("presign status=%d body=%s err=%v", response.StatusCode, raw, err)
	}
	type issuedReply struct {
		Data struct {
			Upload struct {
				UploadTicket string `json:"upload_ticket"`
				Upload       struct {
					URL         string `json:"url"`
					ExpiresAtMS int64  `json:"expires_at_ms"`
					Headers     struct {
						ContentType string `json:"content_type"`
						IfNoneMatch string `json:"if_none_match"`
						Checksum    string `json:"checksum_sha256"`
					} `json:"headers"`
				} `json:"upload"`
			} `json:"upload"`
		} `json:"data"`
	}
	var issued issuedReply
	if err := json.Unmarshal(raw, &issued); err != nil {
		t.Fatal(err)
	}
	target := issued.Data.Upload
	if target.UploadTicket == "" || target.Upload.ExpiresAtMS <= time.Now().UnixMilli() || target.Upload.Headers.ContentType != "image/png" ||
		target.Upload.Headers.IfNoneMatch != "*" || target.Upload.Headers.Checksum != base64.StdEncoding.EncodeToString(digest[:]) || !strings.HasPrefix(target.Upload.URL, storage.URL+"/bucket/supplier-dbs/"+f.sourceA+"/") {
		t.Fatalf("invalid direct-upload wire grant: %s", raw)
	}
	confirmBody, _ := json.Marshal(map[string]string{"upload_ticket": target.UploadTicket})
	missing := f.call(t, http.MethodPost, base+"/uploads/confirm", f.cookieA, string(confirmBody), http.StatusNotFound)
	if !bytes.Contains(missing, []byte(`"code":"UPLOAD_OBJECT_MISSING"`)) {
		t.Fatalf("missing-object response lost retry code: %s", missing)
	}
	f.call(t, http.MethodPost, "/api/admin/supplier-dbs/"+f.sourceB+"/uploads/confirm", f.cookieA, string(confirmBody), http.StatusBadRequest)
	f.call(t, http.MethodPost, base+"/uploads/confirm", f.cookieB, string(confirmBody), http.StatusBadRequest)

	put, err := http.NewRequestWithContext(f.ctx, http.MethodPut, target.Upload.URL, bytes.NewReader(imageBytes))
	if err != nil {
		t.Fatal(err)
	}
	put.Header.Set("Content-Type", target.Upload.Headers.ContentType)
	put.Header.Set("If-None-Match", target.Upload.Headers.IfNoneMatch)
	put.Header.Set("X-Amz-Checksum-Sha256", target.Upload.Headers.Checksum)
	response, err = storage.Client().Do(put)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("direct PUT status=%d", response.StatusCode)
	}
	type confirmedReply struct {
		Data struct {
			Key       string `json:"key"`
			PublicURL string `json:"public_url"`
		} `json:"data"`
	}
	var ready confirmedReply
	for range 2 {
		if err := json.Unmarshal(f.call(t, http.MethodPost, base+"/uploads/confirm", f.cookieA, string(confirmBody), http.StatusOK), &ready); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(ready.Data.Key, "supplier-dbs/"+f.sourceA+"/") || ready.Data.PublicURL != storage.URL+"/bucket/"+ready.Data.Key {
			t.Fatalf("confirmed URL escaped source or configured origin: %+v", ready)
		}
	}
	response, err = storage.Client().Get(ready.Data.PublicURL)
	if err != nil {
		t.Fatal(err)
	}
	publicBytes, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || !bytes.Equal(publicBytes, imageBytes) {
		t.Fatalf("public readback status=%d bytes=%d err=%v", response.StatusCode, len(publicBytes), err)
	}
	storageMu.Lock()
	sidecar := bytes.Clone(objects["/bucket/"+ready.Data.Key+".verified"].body)
	puts, proofs, signed, public := imagePuts, sidecarPuts, signedReads, publicReads
	storageMu.Unlock()
	var persistedProof struct {
		ActorID int64  `json:"actor_id"`
		Token   string `json:"token"`
	}
	if err := json.Unmarshal(sidecar, &persistedProof); err != nil || persistedProof.ActorID != f.managerA || persistedProof.Token != target.UploadTicket || puts != 1 || proofs != 1 || signed != 2 || public != 1 {
		t.Fatalf("confirmation persistence actor=%d PUTs=%d proofs=%d signed/public GETs=%d/%d err=%v", persistedProof.ActorID, puts, proofs, signed, public, err)
	}

	type galleryItem struct {
		URL string `json:"url"`
		W   int    `json:"w"`
		H   int    `json:"h"`
	}
	gallery := []galleryItem{{URL: ready.Data.PublicURL, W: 8, H: 6}}
	rowBody, _ := json.Marshal(map[string]any{"title": "Image row", "gallery": gallery})
	var created struct {
		Data struct {
			Row struct {
				ProductID string        `json:"productId"`
				Gallery   []galleryItem `json:"gallery"`
			} `json:"row"`
		} `json:"data"`
	}
	if err := json.Unmarshal(f.call(t, http.MethodPost, base+"/rows", f.cookieA, string(rowBody), http.StatusCreated), &created); err != nil || created.Data.Row.ProductID == "" || len(created.Data.Row.Gallery) != 1 || created.Data.Row.Gallery[0] != gallery[0] {
		t.Fatalf("row image write failed: %+v err=%v", created, err)
	}
	var detail struct {
		Data struct {
			Rows []struct {
				ProductID string        `json:"productId"`
				Gallery   []galleryItem `json:"gallery"`
			} `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal(f.call(t, http.MethodGet, base, f.cookieA, "", http.StatusOK), &detail); err != nil || len(detail.Data.Rows) != 1 || detail.Data.Rows[0].ProductID != created.Data.Row.ProductID || len(detail.Data.Rows[0].Gallery) != 1 || detail.Data.Rows[0].Gallery[0] != gallery[0] {
		t.Fatalf("detail did not read back image: %+v err=%v", detail, err)
	}
	var persistedGallery []byte
	if err := f.pool.QueryRow(f.ctx, `SELECT gallery FROM sc_products WHERE product_id=$1 AND source_id=$2`, created.Data.Row.ProductID, f.sourceA).Scan(&persistedGallery); err != nil {
		t.Fatal(err)
	}
	var got []galleryItem
	if err := json.Unmarshal(persistedGallery, &got); err != nil || len(got) != 1 || got[0] != gallery[0] {
		t.Fatalf("gallery was not persisted: %s err=%v", persistedGallery, err)
	}

	t.Run("storage_tree_confirmation_is_mounted_and_promotes_the_staged_object", func(t *testing.T) {
		const uploadPath = "/api/admin/supplier-db-storage/uploads"
		const destination = "gallery/storage-confirm.png"
		f.call(t, http.MethodPost, uploadPath+"/confirm", f.cookieB, `{}`, http.StatusForbidden)
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodPost, uploadPath+"/confirm", f.cookieA, `{"path":"gallery/storage-confirm.png","uploadTicket":"retired"}`, http.StatusBadRequest)
		presignBody, _ := json.Marshal(map[string]any{"path": destination, "contentType": "image/png", "bytes": len(imageBytes), "sha256": hex.EncodeToString(digest[:])})
		var target struct {
			Data struct {
				Upload struct {
					Ticket string `json:"upload_ticket"`
					Upload struct {
						URL string `json:"url"`
					} `json:"upload"`
				} `json:"upload"`
			} `json:"data"`
		}
		presign, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+uploadPath, bytes.NewReader(presignBody))
		if err != nil {
			t.Fatal(err)
		}
		presign.Header.Set("Content-Type", "application/json")
		presign.Header.Set("Cookie", f.cookieA)
		presign.Header.Set("X-Podhub-Store-Checksum", "sha256")
		response, err := f.server.Client().Do(presign)
		if err != nil {
			t.Fatal(err)
		}
		presigned, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("storage presign status=%d err=%v", response.StatusCode, err)
		}
		if err := json.Unmarshal(presigned, &target); err != nil || target.Data.Upload.Ticket == "" || !strings.Contains(target.Data.Upload.Upload.URL, "/bucket/.direct-uploads/") {
			t.Fatalf("storage grant was not issued: %v", err)
		}
		confirmation, _ := json.Marshal(map[string]string{"path": destination, "upload_ticket": target.Data.Upload.Ticket})
		missing := f.call(t, http.MethodPost, uploadPath+"/confirm", f.cookieA, string(confirmation), http.StatusNotFound)
		if !bytes.Contains(missing, []byte(`"code":"UPLOAD_OBJECT_MISSING"`)) {
			t.Fatalf("route did not reach missing-object verification: %s", missing)
		}
		put, err := http.NewRequestWithContext(f.ctx, http.MethodPut, target.Data.Upload.Upload.URL, bytes.NewReader(imageBytes))
		if err != nil {
			t.Fatal(err)
		}
		put.Header.Set("Content-Type", "image/png")
		put.Header.Set("If-None-Match", "*")
		put.Header.Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(digest[:]))
		response, err = storage.Client().Do(put)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("staging PUT: %d", response.StatusCode)
		}
		for range 2 {
			var confirmed confirmedReply
			if err := json.Unmarshal(f.call(t, http.MethodPost, uploadPath+"/confirm", f.cookieA, string(confirmation), http.StatusOK), &confirmed); err != nil || confirmed.Data.Key != destination {
				t.Fatalf("storage confirmation failed: %v", err)
			}
		}
		storageMu.Lock()
		promoted := objects["/bucket/"+destination]
		storageMu.Unlock()
		if !bytes.Equal(promoted.body, imageBytes) || promoted.contentType != "image/png" || promoted.promotion == "" {
			t.Fatal("confirmed destination did not persist the verified image and replay marker")
		}
	})
	t.Run("ordinary catalogue manager upload and revocation", func(t *testing.T) {
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='user' WHERE id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		managerBase := "/api/supplier-catalog/sources/" + f.sourceA + "/uploads"
		f.call(t, http.MethodPost, base+"/uploads", f.cookieA, string(body), http.StatusForbidden)
		f.call(t, http.MethodPost, "/api/supplier-catalog/sources/"+f.sourceB+"/uploads", f.cookieA, string(body), http.StatusForbidden)
		var upload issuedReply
		presignRequest, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+managerBase, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		presignRequest.Header.Set("Cookie", f.cookieA)
		presignRequest.Header.Set("Content-Type", "application/json")
		presignRequest.Header.Set("X-Podhub-Store-Checksum", "sha256")
		presigned, err := f.server.Client().Do(presignRequest)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(presigned.Body)
		presigned.Body.Close()
		if err != nil || presigned.StatusCode != http.StatusOK {
			t.Fatalf("manager presign status=%d err=%v", presigned.StatusCode, err)
		}
		if err := json.Unmarshal(raw, &upload); err != nil || upload.Data.Upload.UploadTicket == "" || upload.Data.Upload.Upload.Headers.Checksum == "" {
			t.Fatalf("catalogue manager grant: %v", err)
		}
		request, err := http.NewRequestWithContext(f.ctx, http.MethodPut, upload.Data.Upload.Upload.URL, bytes.NewReader(imageBytes))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", upload.Data.Upload.Upload.Headers.ContentType)
		request.Header.Set("If-None-Match", "*")
		request.Header.Set("X-Amz-Checksum-Sha256", upload.Data.Upload.Upload.Headers.Checksum)
		response, err := storage.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("manager PUT status=%d", response.StatusCode)
		}
		confirmation, _ := json.Marshal(map[string]string{"upload_ticket": upload.Data.Upload.UploadTicket})
		if _, err := f.pool.Exec(f.ctx, `UPDATE sc_catalog_managers SET status='disabled',revoked_at_ms=1 WHERE user_id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodPost, managerBase+"/confirm", f.cookieA, string(confirmation), http.StatusForbidden)
		f.call(t, http.MethodPost, managerBase+"/abort", f.cookieA, string(confirmation), http.StatusForbidden)
		if _, err := f.pool.Exec(f.ctx, `UPDATE sc_catalog_managers SET status='active',revoked_at_ms=NULL WHERE user_id=$1`, f.managerA); err != nil {
			t.Fatal(err)
		}
		var confirmed confirmedReply
		if err := json.Unmarshal(f.call(t, http.MethodPost, managerBase+"/confirm", f.cookieA, string(confirmation), http.StatusOK), &confirmed); err != nil || confirmed.Data.PublicURL == "" {
			t.Fatalf("manager confirmation: %v", err)
		}
	})
	f.assertRole(t)
}
