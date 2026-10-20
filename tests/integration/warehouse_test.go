package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/seller"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/repo"
	whcontract "github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
	warehousehttp "github.com/xxww0098/podhub-go/internal/warehouse/http"
	warehouserepo "github.com/xxww0098/podhub-go/internal/warehouse/repo"
	warehousesvc "github.com/xxww0098/podhub-go/internal/warehouse/service"
)

const warehouseFixtureKey = "fixture-warehouse-api-key"

// TestWarehouseReadWriteArchive covers the loopback cache, the browser-direct
// grant machine, tenant isolation, and the listing tables this feature must
// leave untouched. It does not dial Ozon.
func TestWarehouseReadWriteArchive(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	deadBefore := dbDeadlocks(t, ctx, pool)

	userA, orgA := insertWorkspace(t, ctx, pool, "wh-a-"+uuid.NewString()+"@example.com", "WH A")
	userB, orgB := insertWorkspace(t, ctx, pool, "wh-b-"+uuid.NewString()+"@example.com", "WH B")
	_, storeA := insertNextStore(t, ctx, pool, orgA)
	_, storeB := insertNextStore(t, ctx, pool, orgB)
	_, storeCreate := insertNextStore(t, ctx, pool, orgA)
	_, storeExpire := insertNextStore(t, ctx, pool, orgA)

	rowID := insertFenceRow(t, ctx, pool, orgA, storeA)
	intentID := uuid.NewString()
	if err := insertIntentResult(ctx, pool, intentID, orgA, storeA, rowID, "queued", "listing-op", nil, strPtr("SKU-WH")); err != nil {
		t.Fatal(err)
	}
	jobsBefore := countJobs(t, ctx, pool, orgA)
	listingBefore := listingMark(t, ctx, pool, rowID, intentID)

	box := newWarehouseBox(t, ctx, pool)
	box.seedRLS(t, ctx, orgA, orgB, userA, storeA)

	t.Run("sync is idempotent and tenant scoped", func(t *testing.T) {
		box.name.Store("一号仓")
		rec := box.do(http.MethodPost, "/api/seller/warehouses/sync", `{"storeId":"`+storeA+`"}`, orgA, userA, "owner")
		if rec.Code != http.StatusOK {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var body struct {
			Data struct {
				Warehouses int `json:"warehouses"`
				Methods    int `json:"methods"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Data.Warehouses != 2 || body.Data.Methods != 1 {
			t.Fatal(rec.Body.String())
		}
		box.name.Store("一号仓改")
		rec = box.do(http.MethodPost, "/api/seller/warehouses/sync", `{"storeId":"`+storeA+`"}`, orgA, userA, "owner")
		if rec.Code != http.StatusOK {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var n int
		var archived int
		var name string
		if err := pool.QueryRow(ctx, `
			SELECT count(*), count(*) FILTER (WHERE archived_at IS NOT NULL)
			  FROM public.ozon_warehouses WHERE org_id = $1 AND store_id = $2::uuid`, orgA, storeA).Scan(&n, &archived); err != nil || n != 2 || archived != 0 {
			t.Fatalf("rows %d archived %d %v", n, archived, err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT name FROM public.ozon_warehouses
			 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = 11`, orgA, storeA).Scan(&name); err != nil || name != "一号仓改" {
			t.Fatal(name, err)
		}
		var methods int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_delivery_methods
			 WHERE org_id = $1 AND store_id = $2::uuid`, orgA, storeA).Scan(&methods); err != nil || methods != 1 {
			t.Fatal(methods, err)
		}
		rec = box.do(http.MethodGet, "/api/seller/warehouses?storeId="+storeA, "", orgB, userB, "owner")
		if rec.Code != http.StatusNotFound {
			t.Fatal(rec.Code, rec.Body.String())
		}
		rec = box.do(http.MethodGet, "/api/seller/warehouses?storeId="+storeA, "", orgA, userA, "viewer")
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"warehouseId":11`) || !strings.Contains(rec.Body.String(), `"isActive":true`) {
			t.Fatal(rec.Code, rec.Body.String())
		}
		for _, path := range box.paths() {
			if path == "/v1/warehouse/list" {
				t.Fatal(box.paths())
			}
		}
	})

	t.Run("obsolete v1 is not called", func(t *testing.T) {
		box.obsolete.Store(true)
		before := len(box.paths())
		rec := box.do(http.MethodPost, "/api/seller/warehouses/sync", `{"storeId":"`+storeB+`"}`, orgB, userB, "manager")
		box.obsolete.Store(false)
		if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "ozon_obsolete") {
			t.Fatal(rec.Code, rec.Body.String())
		}
		got := box.paths()[before:]
		if len(got) != 1 || got[0] != domain.PathWarehouseList {
			t.Fatal(got)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.ozon_warehouses WHERE org_id = $1`, orgB).Scan(&n); err != nil || n != 0 {
			t.Fatal(n, err)
		}
		var codes int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_error_observation
			 WHERE org_id = $1 AND source = 'ozon_request' AND code = '9'`, orgB).Scan(&codes); err != nil || codes != 1 {
			t.Fatal(codes, err)
		}
	})

	t.Run("capability archive confirm and cross tenant", func(t *testing.T) {
		rec := box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "arc-no", "archive", false, intPtr(11)), orgA, userA, "member")
		if rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), warehouseFixtureKey) {
			t.Fatal(rec.Code, rec.Body.String())
		}
		rec = box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "arc-no", "archive", false, intPtr(11)), orgA, userA, "owner")
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "confirm_required") || strings.Contains(rec.Body.String(), warehouseFixtureKey) {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var n int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_warehouse_intents
			 WHERE org_id = $1 AND client_operation_id = 'arc-no'`, orgA).Scan(&n); err != nil || n != 0 {
			t.Fatal(n, err)
		}
		rec = box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "cross", "update", false, intPtr(11)), orgB, userB, "owner")
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), warehouseFixtureKey) {
			t.Fatal(rec.Code, rec.Body.String())
		}
		rec = box.do(http.MethodPost, "/api/seller/warehouses/drop-off/list", `{}`, orgA, userA, "owner")
		if rec.Code != http.StatusNotImplemented {
			t.Fatal(rec.Code, rec.Body.String())
		}
	})

	t.Run("grant report state machine", func(t *testing.T) {
		opens := box.opens.Load()
		rec := box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "up-ok", "update", false, intPtr(11)), orgA, userA, "manager")
		if rec.Code != http.StatusOK || strings.Count(rec.Body.String(), warehouseFixtureKey) != 1 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
		}
		if box.opens.Load() != opens+1 {
			t.Fatal(box.opens.Load())
		}
		intent := whIntent(t, rec)
		again := box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "up-ok", "update", false, intPtr(11)), orgA, userA, "owner")
		if again.Code != http.StatusConflict || !strings.Contains(again.Body.String(), "grant_in_flight") || strings.Contains(again.Body.String(), warehouseFixtureKey) {
			t.Fatal(again.Code, again.Body.String())
		}
		if box.opens.Load() != opens+1 {
			t.Fatal("replay opened a key")
		}
		rep := box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`","httpStatus":200,"operationId":"op-11"}`, orgA, userA, "owner")
		if rep.Code != http.StatusOK || !strings.Contains(rep.Body.String(), `"accepted"`) {
			t.Fatal(rep.Code, rep.Body.String())
		}
		assertWarehouseIntent(t, ctx, pool, intent, "accepted", "")
		bad := box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`","httpStatus":500}`, orgA, userA, "owner")
		if bad.Code != http.StatusConflict || !strings.Contains(bad.Body.String(), "report_state") {
			t.Fatal(bad.Code, bad.Body.String())
		}
		assertWarehouseIntent(t, ctx, pool, intent, "accepted", "")
		status := box.do(http.MethodPost, "/api/seller/warehouses/operations/status", `{"storeId":"`+storeA+`","operationId":"op-11"}`, orgA, userA, "viewer")
		if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"SUCCESS"`) {
			t.Fatal(status.Code, status.Body.String())
		}
		missing := box.do(http.MethodPost, "/api/seller/warehouses/operations/status", `{"storeId":"`+storeA+`","operationId":"nope"}`, orgA, userA, "owner")
		if missing.Code != http.StatusNotFound {
			t.Fatal(missing.Code, missing.Body.String())
		}

		rec = box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "up-403", "update", false, intPtr(11)), orgA, userA, "owner")
		intent = whIntent(t, rec)
		rep = box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`","httpStatus":403}`, orgA, userA, "owner")
		if rep.Code != http.StatusOK || !strings.Contains(rep.Body.String(), `"rejected"`) {
			t.Fatal(rep.Code, rep.Body.String())
		}
		assertWarehouseIntent(t, ctx, pool, intent, "rejected", "OZON_ACCESS_UNCLASSIFIED")
		var grpc7 int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_error_observation
			 WHERE org_id = $1 AND source = 'ozon_request' AND code = '7'`, orgA).Scan(&grpc7); err != nil || grpc7 != 1 {
			t.Fatal(grpc7, err)
		}

		rec = box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "up-400", "update", false, intPtr(11)), orgA, userA, "owner")
		intent = whIntent(t, rec)
		rep = box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`","httpStatus":422}`, orgA, userA, "owner")
		if rep.Code != http.StatusOK {
			t.Fatal(rep.Code, rep.Body.String())
		}
		assertWarehouseIntent(t, ctx, pool, intent, "rejected", "OZON_ROW_REJECTED")
		var grpc3 int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_error_observation
			 WHERE org_id = $1 AND source = 'ozon_request' AND code = '3'`, orgA).Scan(&grpc3); err != nil || grpc3 != 0 {
			t.Fatal(grpc3, err)
		}

		rec = box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "up-none", "update", false, intPtr(12)), orgA, userA, "owner")
		intent = whIntent(t, rec)
		rep = box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`"}`, orgA, userA, "owner")
		if rep.Code != http.StatusOK || !strings.Contains(rep.Body.String(), `"unknown"`) {
			t.Fatal(rep.Code, rep.Body.String())
		}
		assertWarehouseIntent(t, ctx, pool, intent, "unknown", "OZON_DISPATCH_INTERRUPTED")
		held := box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "up-held", "update", false, intPtr(12)), orgA, userA, "owner")
		if held.Code != http.StatusConflict || !strings.Contains(held.Body.String(), "warehouse_busy") || strings.Contains(held.Body.String(), warehouseFixtureKey) {
			t.Fatal(held.Code, held.Body.String())
		}
	})

	t.Run("concurrent writers", func(t *testing.T) {
		box.syncStore(t, storeCreate)
		wh := int64(11)
		opens := box.opens.Load()
		var wg sync.WaitGroup
		start := make(chan struct{})
		type result struct {
			res warehousesvc.GrantResult
			err error
		}
		out := make([]result, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				res, err := box.svc.Grant(ctx, warehousesvc.GrantInput{GrantWrite: whcontract.GrantWrite{
					OrgID: orgA, UserID: userA, StoreID: storeCreate,
					ClientOperationID: fmt.Sprintf("race-%d", i), Kind: whcontract.KindUpdate, WarehouseID: &wh,
				}, Role: "owner"})
				out[i] = result{res, err}
			}(i)
		}
		close(start)
		wg.Wait()
		var won, lost int
		for _, item := range out {
			if item.err == nil {
				won++
				if item.res.APIKey != warehouseFixtureKey {
					t.Fatal(item.res.APIKey)
				}
				continue
			}
			lost++
			var pg *pgconn.PgError
			if errors.As(item.err, &pg) && pg.Code == "40P01" {
				t.Fatal(item.err)
			}
			if !errors.Is(item.err, whcontract.Busy()) || item.res.APIKey != "" {
				t.Fatal(item.err, item.res.APIKey)
			}
		}
		if won != 1 || lost != 1 || box.opens.Load() != opens+1 {
			t.Fatalf("won %d lost %d opens %d", won, lost, box.opens.Load()-opens)
		}

		opens = box.opens.Load()
		out = make([]result, 2)
		start = make(chan struct{})
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				res, err := box.svc.Grant(ctx, warehousesvc.GrantInput{GrantWrite: whcontract.GrantWrite{
					OrgID: orgA, UserID: userA, StoreID: storeExpire,
					ClientOperationID: fmt.Sprintf("create-%d", i), Kind: whcontract.KindCreate,
				}, Role: "owner"})
				out[i] = result{res, err}
			}(i)
		}
		close(start)
		wg.Wait()
		won, lost = 0, 0
		for _, item := range out {
			if item.err == nil {
				won++
				continue
			}
			lost++
			if !errors.Is(item.err, whcontract.Busy()) {
				t.Fatal(item.err)
			}
		}
		if won != 1 || lost != 1 || box.opens.Load() != opens+1 {
			t.Fatalf("create won %d lost %d opens %d", won, lost, box.opens.Load()-opens)
		}
	})

	t.Run("expired grant does not return a second key", func(t *testing.T) {
		id := int64(4)
		_, err := box.svc.Grant(ctx, warehousesvc.GrantInput{GrantWrite: whcontract.GrantWrite{
			OrgID: orgA, UserID: userA, StoreID: storeCreate,
			ClientOperationID: "with-id", Kind: whcontract.KindCreate, WarehouseID: &id,
		}, Role: "owner"})
		if !errors.Is(err, whcontract.BadRequest("创建仓库不要带 warehouse_id")) {
			t.Fatal(err)
		}
		var held string
		if err := pool.QueryRow(ctx, `
			SELECT client_operation_id FROM public.ozon_warehouse_intents
			 WHERE org_id = $1 AND store_id = $2::uuid AND state = 'granted' AND kind = 'create'`,
			orgA, storeExpire).Scan(&held); err != nil {
			t.Fatal(err)
		}
		box.clock.Store(box.clock.Load().(time.Time).Add(121 * time.Second))
		opens := box.opens.Load()
		_, err = box.svc.Grant(ctx, warehousesvc.GrantInput{GrantWrite: whcontract.GrantWrite{
			OrgID: orgA, UserID: userA, StoreID: storeExpire,
			ClientOperationID: held, Kind: whcontract.KindCreate,
		}, Role: "owner"})
		if !errors.Is(err, whcontract.GrantExpired()) || box.opens.Load() != opens {
			t.Fatal(err, box.opens.Load()-opens)
		}
		got, err := box.svc.Grant(ctx, warehousesvc.GrantInput{GrantWrite: whcontract.GrantWrite{
			OrgID: orgA, UserID: userA, StoreID: storeExpire,
			ClientOperationID: "create-next", Kind: whcontract.KindCreate,
		}, Role: "owner"})
		if err != nil || got.APIKey != warehouseFixtureKey || box.opens.Load() != opens+1 {
			t.Fatal(err, got.APIKey, box.opens.Load()-opens)
		}
	})

	t.Run("archive then sync keeps the local mark", func(t *testing.T) {
		rec := box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "arc-yes", "archive", true, intPtr(11)), orgA, userA, "owner")
		intent := whIntent(t, rec)
		rep := box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`","httpStatus":200,"operationId":"op-arc"}`, orgA, userA, "owner")
		if rep.Code != http.StatusOK {
			t.Fatal(rep.Code, rep.Body.String())
		}
		var archived bool
		if err := pool.QueryRow(ctx, `
			SELECT archived_at IS NOT NULL FROM public.ozon_warehouses
			 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = 11`, orgA, storeA).Scan(&archived); err != nil || !archived {
			t.Fatal(archived, err)
		}
		box.name.Store("归档后")
		rec = box.do(http.MethodPost, "/api/seller/warehouses/sync", `{"storeId":"`+storeA+`"}`, orgA, userA, "owner")
		if rec.Code != http.StatusOK {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var name string
		if err := pool.QueryRow(ctx, `
			SELECT name, archived_at IS NOT NULL FROM public.ozon_warehouses
			 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = 11`, orgA, storeA).Scan(&name, &archived); err != nil || name != "归档后" || !archived {
			t.Fatal(name, archived, err)
		}
		rec = box.do(http.MethodGet, "/api/seller/warehouses/11?storeId="+storeA, "", orgA, userA, "owner")
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"archived":true`) || !strings.Contains(rec.Body.String(), `"isActive":false`) {
			t.Fatal(rec.Code, rec.Body.String())
		}
		rec = box.do(http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "un-yes", "unarchive", false, intPtr(11)), orgA, userA, "owner")
		intent = whIntent(t, rec)
		rep = box.do(http.MethodPost, "/api/seller/warehouses/report", `{"intentId":"`+intent+`","httpStatus":200,"operationId":"op-un"}`, orgA, userA, "owner")
		if rep.Code != http.StatusOK {
			t.Fatal(rep.Code, rep.Body.String())
		}
		if err := pool.QueryRow(ctx, `
			SELECT archived_at IS NOT NULL FROM public.ozon_warehouses
			 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = 11`, orgA, storeA).Scan(&archived); err != nil || archived {
			t.Fatal(archived, err)
		}
	})

	t.Run("kill switch", func(t *testing.T) {
		opens := box.opens.Load()
		var budgets int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.lease_budget WHERE scope LIKE 'warehouse-grant:%'`).Scan(&budgets); err != nil {
			t.Fatal(err)
		}
		var logs strings.Builder
		prev := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
		defer slog.SetDefault(prev)
		rec := box.doOn(box.blocked, http.MethodPost, "/api/seller/warehouses/grant", whGrantJSON(storeA, "killed", "create", false, nil), orgA, userA, "owner")
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "OZON_WRITES_DISABLED") {
			t.Fatal(rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), warehouseFixtureKey) || strings.Contains(logs.String(), warehouseFixtureKey) || box.opens.Load() != opens {
			t.Fatal(rec.Body.String(), logs.String(), box.opens.Load())
		}
		var after int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.lease_budget WHERE scope LIKE 'warehouse-grant:%'`).Scan(&after); err != nil || after != budgets {
			t.Fatalf("budget %d -> %d %v", budgets, after, err)
		}
		var message string
		if err := pool.QueryRow(ctx, `
			SELECT message FROM public.audit_logs
			 WHERE org_id = $1 AND action = 'warehouse_grant_refused'
			 ORDER BY id DESC LIMIT 1`, orgA).Scan(&message); err != nil || message != "Ozon 写入已停止" || strings.Contains(message, warehouseFixtureKey) {
			t.Fatal(message, err)
		}
		rec = box.doOn(box.blocked, http.MethodPost, "/api/seller/warehouses/sync", `{"storeId":"`+storeB+`"}`, orgB, userB, "owner")
		if rec.Code != http.StatusOK {
			t.Fatal(rec.Code, rec.Body.String())
		}
	})

	if got := dbDeadlocks(t, ctx, pool); got != deadBefore {
		t.Fatalf("deadlocks %d -> %d", deadBefore, got)
	}
	if got := listingMark(t, ctx, pool, rowID, intentID); got != listingBefore {
		t.Fatalf("listing changed %s -> %s", listingBefore, got)
	}
	if got := countJobs(t, ctx, pool, orgA); got != jobsBefore {
		t.Fatalf("jobs %d -> %d", jobsBefore, got)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM public.audit_logs
		 WHERE message LIKE '%' || $1 || '%' OR coalesce(result, '') LIKE '%' || $1 || '%'`, warehouseFixtureKey).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatal(leaked, err)
	}
}

type warehouseBox struct {
	t        *testing.T
	ctx      context.Context
	pool     *pgxpool.Pool
	h        http.Handler
	blocked  http.Handler
	svc      warehousesvc.Service
	opens    atomic.Int32
	obsolete atomic.Bool
	name     atomic.Value
	clock    atomic.Value
	mu       sync.Mutex
	seen     []string
}

func newWarehouseBox(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *warehouseBox {
	t.Helper()
	box := &warehouseBox{t: t, ctx: ctx, pool: pool}
	box.name.Store("一号仓")
	box.clock.Store(time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC))
	mock := httptest.NewServer(http.HandlerFunc(box.serve))
	t.Cleanup(mock.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", mock.URL+"/")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "")
	cfg := config.Load()
	if cfg.OzonWritesDisabled() || !strings.HasPrefix(cfg.SellerBaseURL(), "http://127.0.0.1:") {
		t.Fatal(cfg.OzonWritesDisabled(), cfg.SellerBaseURL())
	}
	repo := warehouserepo.New(pool)
	box.svc = warehousesvc.Service{
		DB:     repo,
		Open:   warehouseOpener{n: &box.opens},
		Post:   warehousePoster{eg: seller.New(cfg).WithPool(pool)},
		Limit:  warehouseLimit{pool: pool},
		Errors: app.WarehouseCatalog(pool),
		Now:    func() time.Time { return box.clock.Load().(time.Time) },
	}
	deps := warehousehttp.Deps{
		Session: warehouseHeaderSession{},
		Actions: box.svc,
		Read: func(role string) bool {
			parsed, ok := identity.ParseWorkspaceRole(role)
			return ok && parsed.Allows(identity.CapStoreRead)
		},
		Write: func(role string) bool {
			parsed, ok := identity.ParseWorkspaceRole(role)
			return ok && parsed.Allows(identity.CapWarehouseWrite)
		},
		Now: time.Now,
	}
	live := chi.NewRouter()
	warehousehttp.Mount(live, deps)
	deps.WritesDisabled = true
	blocked := chi.NewRouter()
	warehousehttp.Mount(blocked, deps)
	box.h = live
	box.blocked = blocked
	return box
}

func (b *warehouseBox) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	b.mu.Lock()
	b.seen = append(b.seen, r.URL.Path)
	b.mu.Unlock()
	if r.Header.Get("Api-Key") != warehouseFixtureKey || r.Header.Get("Client-Id") != "fixture-client-id" {
		http.Error(w, "credential", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/v1/warehouse/list" || (b.obsolete.Load() && r.URL.Path == domain.PathWarehouseList) {
		_, _ = io.WriteString(w, `{"code":9,"message":"obsolete method"}`)
		return
	}
	switch r.URL.Path {
	case domain.PathWarehouseList:
		name, _ := b.name.Load().(string)
		raw, err := json.Marshal(map[string]any{
			"has_next": false,
			"warehouses": []map[string]any{
				{"warehouse_id": 11, "name": name, "status": "created", "is_rfbs": true},
				{"warehouse_id": 12, "name": "备仓", "status": "created", "is_rfbs": false},
			},
		})
		if err != nil {
			http.Error(w, "json", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write(raw)
	case domain.PathMethodList:
		if strings.Contains(string(raw), `"status"`) || strings.Contains(string(raw), `"provider_id"`) {
			http.Error(w, "filter", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"has_next":false,"result":[{"id":21,"name":"快递","warehouse_id":11,"provider_id":4,"template_id":"tpl","cutoff":"18:00","sla_cut_in":90,"status":"ACTIVE","created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-03T03:04:05Z"}]}`)
	case domain.PathOperation:
		_, _ = io.WriteString(w, `{"status":"SUCCESS","result":{"warehouse_id":11}}`)
	default:
		http.Error(w, "path", http.StatusNotFound)
	}
}

func (b *warehouseBox) paths() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, len(b.seen))
	copy(out, b.seen)
	return out
}

func (b *warehouseBox) do(method, path, body string, org, user int64, role string) *httptest.ResponseRecorder {
	return b.doOn(b.h, method, path, body, org, user, role)
}

func (b *warehouseBox) doOn(h http.Handler, method, path, body string, org, user int64, role string) *httptest.ResponseRecorder {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("X-Wh-Org", strconv.FormatInt(org, 10))
	req.Header.Set("X-Wh-User", strconv.FormatInt(user, 10))
	req.Header.Set("X-Wh-Role", role)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func (b *warehouseBox) syncStore(t *testing.T, store string) {
	t.Helper()
	rec := b.do(http.MethodPost, "/api/seller/warehouses/sync", `{"storeId":"`+store+`"}`, b.orgFromStore(t, store), b.userFromStore(t, store), "owner")
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code, rec.Body.String())
	}
}

func (b *warehouseBox) orgFromStore(t *testing.T, store string) int64 {
	t.Helper()
	var org int64
	if err := b.pool.QueryRow(b.ctx, `SELECT org_id FROM public.organization_stores WHERE uuid = $1::uuid`, store).Scan(&org); err != nil {
		t.Fatal(err)
	}
	return org
}

func (b *warehouseBox) userFromStore(t *testing.T, store string) int64 {
	t.Helper()
	var user int64
	if err := b.pool.QueryRow(b.ctx, `
		SELECT owner_user_id FROM public.organizations
		 WHERE id = (SELECT org_id FROM public.organization_stores WHERE uuid = $1::uuid)`, store).Scan(&user); err != nil {
		t.Fatal(err)
	}
	return user
}

func (b *warehouseBox) seedRLS(t *testing.T, ctx context.Context, orgA, orgB, userA int64, storeA string) {
	t.Helper()
	if _, err := b.pool.Exec(ctx, `
		INSERT INTO public.ozon_warehouses (org_id, store_id, warehouse_id, name, ozon_status, is_rfbs, synced_at)
		VALUES ($1, $2::uuid, 99, '隔离', 'created', false, clock_timestamp())`, orgA, storeA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `
		INSERT INTO public.ozon_delivery_methods (org_id, store_id, method_id, warehouse_id, name, synced_at)
		VALUES ($1, $2::uuid, 5, 99, '隔离', clock_timestamp())`, orgA, storeA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `
		INSERT INTO public.ozon_warehouse_sync (org_id, store_id, warehouses_synced_at)
		VALUES ($1, $2::uuid, clock_timestamp())`, orgA, storeA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `
		INSERT INTO public.ozon_warehouse_fences (org_id, store_id, warehouse_id)
		VALUES ($1, $2::uuid, 99)`, orgA, storeA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `
		INSERT INTO public.ozon_warehouse_intents (
			id, org_id, store_id, user_id, client_operation_id, kind, warehouse_id, fence_warehouse_id, confirm, state
		) VALUES ($1::uuid, $2, $3::uuid, $4, 'rls-op', 'update', 99, 99, false, 'rejected')`,
		uuid.NewString(), orgA, storeA, userA); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"ozon_warehouses", "ozon_delivery_methods", "ozon_warehouse_sync", "ozon_warehouse_fences", "ozon_warehouse_intents"} {
		txA, err := tenant.BeginApp(ctx, b.pool.Begin, orgA)
		if err != nil {
			t.Fatal(err)
		}
		var seen int
		if err := txA.QueryRow(ctx, `SELECT count(*) FROM public.`+table).Scan(&seen); err != nil || seen != 1 {
			t.Fatalf("%s org A sees %d %v", table, seen, err)
		}
		_ = txA.Rollback(ctx)

		txB, err := tenant.BeginApp(ctx, b.pool.Begin, orgB)
		if err != nil {
			t.Fatal(err)
		}
		if err := txB.QueryRow(ctx, `SELECT count(*) FROM public.`+table).Scan(&seen); err != nil || seen != 0 {
			t.Fatalf("%s org B sees %d %v", table, seen, err)
		}
		_ = txB.Rollback(ctx)

		bare, err := b.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		if err := bare.QueryRow(ctx, `SELECT count(*) FROM public.`+table).Scan(&seen); err != nil || seen != 0 {
			t.Fatalf("%s missing GUC sees %d %v", table, seen, err)
		}
		_ = bare.Rollback(ctx)
	}
	txA, err := tenant.BeginApp(ctx, b.pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := txA.Exec(ctx, `
		INSERT INTO public.ozon_warehouses (org_id, store_id, warehouse_id, name, ozon_status, is_rfbs, synced_at)
		VALUES ($1, $2::uuid, 98, '越权', 'created', false, clock_timestamp())`, orgB, storeA); err == nil {
		t.Fatal("org A inserted org B")
	}
	_ = txA.Rollback(ctx)
	bare, err := b.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := bare.Exec(ctx, `
		INSERT INTO public.ozon_warehouses (org_id, store_id, warehouse_id, name, ozon_status, is_rfbs, synced_at)
		VALUES ($1, $2::uuid, 98, '无GUC', 'created', false, clock_timestamp())`, orgA, storeA); err == nil {
		t.Fatal("missing GUC inserted")
	}
	_ = bare.Rollback(ctx)
	if _, err := b.pool.Exec(ctx, `DELETE FROM public.ozon_warehouse_intents WHERE org_id = $1`, orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `DELETE FROM public.ozon_warehouse_fences WHERE org_id = $1`, orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `DELETE FROM public.ozon_delivery_methods WHERE org_id = $1`, orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `DELETE FROM public.ozon_warehouses WHERE org_id = $1`, orgA); err != nil {
		t.Fatal(err)
	}
	if _, err := b.pool.Exec(ctx, `DELETE FROM public.ozon_warehouse_sync WHERE org_id = $1`, orgA); err != nil {
		t.Fatal(err)
	}
}

type warehouseHeaderSession struct{}

func (warehouseHeaderSession) Resolve(r *http.Request) (*warehousehttp.Principal, *warehousehttp.Refusal, error) {
	org, _ := strconv.ParseInt(r.Header.Get("X-Wh-Org"), 10, 64)
	user, _ := strconv.ParseInt(r.Header.Get("X-Wh-User"), 10, 64)
	return &warehousehttp.Principal{UserID: user, OrgID: org, WorkspaceRole: r.Header.Get("X-Wh-Role")}, nil, nil
}

type warehouseOpener struct{ n *atomic.Int32 }

func (o warehouseOpener) Open(context.Context, int64, int64, string, string, time.Time) (string, string, error) {
	o.n.Add(1)
	return "fixture-client-id", warehouseFixtureKey, nil
}

type warehousePoster struct{ eg *seller.Egress }

func (p warehousePoster) Post(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	reply, err := p.eg.Call(ctx, http.MethodPost, path, body, false, true, clientID, apiKey)
	if errors.Is(err, sellerrepo.ErrRateLimited) {
		return 0, nil, whcontract.ErrRateLimited
	}
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

type warehouseLimit struct{ pool *pgxpool.Pool }

func (b warehouseLimit) Reserve(ctx context.Context, scope string) error {
	interval := time.Second / time.Duration(sellerdomain.DefaultRatePerSecond)
	burst := interval * time.Duration(sellerdomain.DefaultBurst-1)
	wait, err := sellerrepo.Reserve(ctx, b.pool, sellerdomain.Namespace(), scope, interval, burst, sellerdomain.MaxRateLimitWait)
	if errors.Is(err, sellerrepo.ErrRateLimited) {
		return whcontract.ErrRateLimited
	}
	if err != nil {
		return err
	}
	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func whGrantJSON(store, op, kind string, confirm bool, warehouse *int64) string {
	body := map[string]any{"storeId": store, "clientOperationId": op, "kind": kind, "confirm": confirm}
	if warehouse != nil {
		body["warehouseId"] = *warehouse
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func whIntent(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var body struct {
		Data struct {
			IntentID string `json:"intentId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Data.IntentID == "" {
		t.Fatal(err, rec.Body.String())
	}
	return body.Data.IntentID
}

func assertWarehouseIntent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, state, code string) {
	t.Helper()
	var gotState, gotCode string
	if err := pool.QueryRow(ctx, `
		SELECT state, coalesce(error_code, '') FROM public.ozon_warehouse_intents WHERE id = $1::uuid`, id).Scan(&gotState, &gotCode); err != nil {
		t.Fatal(err)
	}
	if gotState != state || gotCode != code {
		t.Fatalf("state %s code %s", gotState, gotCode)
	}
}

func intPtr(n int64) *int64 { return &n }

func dbDeadlocks(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func listingMark(t *testing.T, ctx context.Context, pool *pgxpool.Pool, row, intent string) string {
	t.Helper()
	var rows, intents int
	var state, revision, sub, offer string
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.listing_rows`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents`).Scan(&intents); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT submission_state, revision::text FROM public.listing_rows WHERE id = $1::uuid`, row).Scan(&state, &revision); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT state, coalesce(offer_id, '') FROM public.submission_intents WHERE id = $1::uuid`, intent).Scan(&sub, &offer); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%d|%d|%s|%s|%s|%s", rows, intents, state, revision, sub, offer)
}
