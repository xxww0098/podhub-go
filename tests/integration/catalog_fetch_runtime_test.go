package integration

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	catalogservice "github.com/xxww0098/podhub-go/internal/catalog/service"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func TestCatalogFetchRuntimeOrdinaryRole(t *testing.T) {
	var mode atomic.Int32
	var good, bad atomic.Int32
	var privateCalls, attributeCalls atomic.Int32
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Error("unexpected Seller method")
		}
		if r.Header.Get("Client-Id") == "bad" {
			bad.Add(1)
			http.Error(w, "denied", 401)
			return
		}
		if r.Header.Get("Client-Id") != "good" || r.Header.Get("Api-Key") != "catalog-test-secret" {
			t.Error("lost catalog credential")
		}
		good.Add(1)
		switch r.URL.Path {
		case "/v1/description-category/tree":
			if mode.Load() == 1 {
				select {
				case entered <- struct{}{}:
				default:
				}
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			if mode.Load() == 2 {
				http.Error(w, "unavailable", 502)
				return
			}
			io.WriteString(w, `{"result":[{"description_category_id":17027906,"category_name":"Test category","children":[{"type_id":91976,"type_name":"Mug"},{"type_id":91999,"type_name":"Draft"}]}]}`)
		case "/v1/description-category/attribute":
			attributeCalls.Add(1)
			var coordinate struct {
				Category int64 `json:"description_category_id"`
				TypeID   int64 `json:"type_id"`
			}
			if json.NewDecoder(r.Body).Decode(&coordinate) != nil {
				t.Error("invalid coordinate request")
			}
			if coordinate.Category == 17027906 && coordinate.TypeID == 91999 {
				privateCalls.Add(1)
			}
			io.WriteString(w, `{"result":[]}`)
		default:
			t.Errorf("unexpected Seller request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	t.Setenv("CLOUD_SELLER_BASE_URL", upstream.URL+"/")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "catalog-test-envelope-key")
	f := newAdminContentFixture(t)
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_sources(source_id,name,created_at_ms,updated_at_ms) VALUES('catalog-fetch-private','Private draft',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO sc_products(product_id,source_id,title,published,description_category_id,type_id,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES('catalog-fetch-draft','catalog-fetch-private','Draft',false,17027906,91999,1,1,'qa')`); err != nil {
		t.Fatal(err)
	}
	const configPath = "/api/admin/catalog/fetch-config"
	const runPath = configPath + "/run"
	f.want(t, http.MethodPost, runPath, `{}`, f.user, 403)
	f.want(t, http.MethodPost, runPath, `{}`, f.admin, 400)
	const configBody = `{"enabled":false,"schedule_mode":"fixed","at_minute":180,"window_start_minute":120,"window_end_minute":240,"utc_offset_minutes":480,"keys":[{"client_id":"bad","api_key":"bad-key"},{"client_id":"good","api_key":"catalog-test-secret"}]}`
	f.want(t, http.MethodPut, configPath, configBody, f.admin, 200)
	f.want(t, http.MethodGet, "/api/catalog/schema?description_category_id=17027906&type_id=91976&language=zh_hans", "", f.admin, 200)
	mode.Store(1)
	accepted := f.want(t, http.MethodPost, runPath, `{}`, f.admin, 200)
	if !strings.Contains(string(accepted), `"running":true`) {
		t.Fatalf("accepted without committed claim: %s", accepted)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("accepted run never started")
	}
	f.want(t, http.MethodPost, runPath, `{}`, f.admin, 409)
	unblock()
	wait := func(want string, streak int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			raw := f.want(t, http.MethodGet, configPath, "", f.admin, 200)
			var view struct {
				Running  bool    `json:"running"`
				Status   *string `json:"last_status"`
				Streak   int     `json:"failure_streak"`
				Roots    *int    `json:"last_root_nodes"`
				Attempts int     `json:"last_key_attempts"`
			}
			if json.Unmarshal(raw, &view) != nil {
				t.Fatal("invalid fetch view")
			}
			if !view.Running && view.Status != nil && *view.Status == want && view.Streak == streak {
				if want == "ok" && (view.Roots == nil || *view.Roots != 1 || view.Attempts != 2) {
					t.Fatalf("incorrect run receipt: %s", raw)
				}
				if strings.Contains(string(raw), "catalog-test-secret") {
					t.Fatal("key leaked")
				}
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("run did not finish %s", want)
	}
	wait("ok", 0)
	var current, versions int
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM ozon_category_current WHERE language='zh_hans'),(SELECT count(*) FROM listing_schema_revisions)`).Scan(&current, &versions); err != nil || current != 1 || versions < 1 || privateCalls.Load() != 0 {
		t.Fatalf("scheduled run crawled a coordinate: current=%d versions=%d private=%d err=%v", current, versions, privateCalls.Load(), err)
	}
	mode.Store(2)
	f.want(t, http.MethodPost, runPath, `{}`, f.admin, 200)
	wait("failed", 1)
	mode.Store(0)
	f.want(t, http.MethodPost, runPath, `{}`, f.admin, 200)
	wait("ok", 0)
	if bad.Load() < 3 || good.Load() < 3 {
		t.Fatal("failover was not exercised")
	}
	// The scheduled runs only refreshed the tree. The draft coordinate stays
	// unfetched until a product form asks for it, then its schema is loaded and
	// cached on demand.
	if got := attributeCalls.Load(); got != 1 {
		t.Fatalf("scheduled run fetched a coordinate: attribute calls = %d, want 1", got)
	}
	f.want(t, http.MethodGet, "/api/catalog/schema?description_category_id=17027906&type_id=91999&language=zh_hans", "", f.admin, 200)
	if got := attributeCalls.Load(); got != 2 || privateCalls.Load() != 1 {
		t.Fatalf("on-demand schema not loaded: attribute calls = %d, private calls = %d", got, privateCalls.Load())
	}
	// Saving a daily schedule pins a future wall-clock slot instead of executing.
	raw := f.want(t, http.MethodPut, configPath, strings.Replace(configBody, `"enabled":false`, `"enabled":true`, 1), f.admin, 200)
	var view struct {
		Next    *int64 `json:"next_run_at_ms"`
		Enabled bool   `json:"enabled"`
	}
	if json.Unmarshal(raw, &view) != nil || !view.Enabled || view.Next == nil || *view.Next <= time.Now().UnixMilli() {
		t.Fatalf("daily schedule not pinned: %s", raw)
	}
	f.assertClean(t)
}

func TestCatalogFetchFencesExpiredAndReconfiguredRuns(t *testing.T) {
	f := newAdminContentFixture(t)
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_config(singleton,enabled,next_run_at_ms) VALUES(true,true,1)`); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	var fenced atomic.Bool
	first := &catalogservice.Fetcher{Pool: f.runtime, Context: f.ctx, Execute: func(ctx context.Context, claim catalogservice.FetchClaim) (catalogservice.FetchResult, error) {
		calls.Add(1)
		close(entered)
		<-release
		err := db.InTx(ctx, f.runtime, db.AppRole(), func(tx pgx.Tx) error {
			defer writer.Forget(tx)
			return catalogservice.AssertFetchClaim(ctx, tx, claim, time.Now())
		})
		fenced.Store(err != nil)
		return catalogservice.FetchResult{}, err
	}}
	started, err := first.Start(f.ctx, false)
	if err != nil || !started {
		t.Fatalf("scheduled start=%v err=%v", started, err)
	}
	<-entered
	if started, err := first.Start(f.ctx, false); err != nil || started {
		t.Fatalf("duplicate scheduled work: %v %v", started, err)
	}
	// A crashed process leaves an expired lease, even though next_run is tomorrow.
	if _, err := f.fixture.Exec(f.ctx, `UPDATE platform_catalog_fetch_config SET lease_until_ms=1`); err != nil {
		t.Fatal(err)
	}
	second := &catalogservice.Fetcher{Pool: f.runtime, Context: f.ctx, Execute: func(context.Context, catalogservice.FetchClaim) (catalogservice.FetchResult, error) {
		calls.Add(1)
		return catalogservice.FetchResult{RootNodes: 2}, nil
	}}
	if started, err := second.Start(f.ctx, false); err != nil || !started {
		t.Fatalf("abandoned run not recovered: %v %v", started, err)
	}
	second.Wait()
	close(release)
	first.Wait()
	var status string
	var roots int
	if err := f.fixture.QueryRow(f.ctx, `SELECT last_status,last_root_nodes FROM platform_catalog_fetch_config`).Scan(&status, &roots); err != nil || status != "ok" || roots != 2 || !fenced.Load() || calls.Load() != 2 {
		t.Fatalf("stale owner overwrote receipt: %s/%d fenced=%v calls=%d err=%v", status, roots, fenced.Load(), calls.Load(), err)
	}
	// Revoking/changing configuration also changes its epoch, fencing old output.
	var claim catalogservice.FetchClaim
	if err := f.fixture.QueryRow(f.ctx, `UPDATE platform_catalog_fetch_config SET lease_epoch=lease_epoch+1,lease_until_ms=$1 RETURNING lease_epoch`, time.Now().Add(time.Minute).UnixMilli()).Scan(&claim.Epoch); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE platform_catalog_fetch_config SET lease_epoch=lease_epoch+1,lease_until_ms=NULL`); err != nil {
		t.Fatal(err)
	}
	if err := db.InTx(f.ctx, f.runtime, db.AppRole(), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		return catalogservice.AssertFetchClaim(f.ctx, tx, claim, time.Now())
	}); err == nil {
		t.Fatal("reconfigured claim still authorized")
	}
	// A manual accepted run must recover after a crash even with daily jobs off.
	if _, err := f.fixture.Exec(f.ctx, `UPDATE platform_catalog_fetch_config SET enabled=false,lease_until_ms=1,next_run_at_ms=NULL`); err != nil {
		t.Fatal(err)
	}
	resumed := &catalogservice.Fetcher{Pool: f.runtime, Context: f.ctx, Execute: func(context.Context, catalogservice.FetchClaim) (catalogservice.FetchResult, error) {
		return catalogservice.FetchResult{RootNodes: 3}, nil
	}}
	if started, err := resumed.Start(f.ctx, false); err != nil || !started {
		t.Fatalf("expired manual run stranded with schedule disabled: %v %v", started, err)
	}
	resumed.Wait()
	f.assertClean(t)
}
