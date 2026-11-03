package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	opscontract "github.com/xxww0098/podhub-go/internal/ops/contract"
	opsdomain "github.com/xxww0098/podhub-go/internal/ops/domain"
	opsrepo "github.com/xxww0098/podhub-go/internal/ops/repo"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestOpsPriceTargetFence(t *testing.T) {
	var readMode atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/seller/info" {
			_, _ = w.Write([]byte(`{"company":{"name":"Fence fixture"}}`))
			return
		}
		if r.URL.Path == "/v5/product/info/prices" {
			if readMode.Load() == 0 {
				_, _ = w.Write([]byte(`{}`))
			} else {
				_, _ = w.Write([]byte(`{"items":[{"product_id":6706622242,"offer_id":"price-fence-concurrent","price":{"price":"61.00","old_price":"0","currency_code":"CNY"}}]}`))
			}
			return
		}
		if r.URL.Path != "/v1/roles" {
			t.Errorf("unexpected external write %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"roles":[{"name":"test","methods":["/v1/product/import/prices"]}]}`))
	}))
	defer upstream.Close()
	a := newPriceAPI(t, "fence-fixture-client", "fence-fixture-key", upstream.URL+"/")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	config := a.pool.Config()
	config.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ledger := opsrepo.New(pool, seal.Ring{}, false, "")
	body := func(product int64, offer, kind string) []byte {
		raw, err := json.Marshal(map[string]any{"kind": kind, "items": []any{map[string]any{
			"product_id": product, "offer_id": offer, "price": "62.01", "old_price": "0", "currency_code": "CNY",
		}}})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	key := func() string { return opsdomain.ProductKey(a.store, uuid.NewString()) }
	begin := func(id string, raw []byte) (opscontract.LedgerRow, error) {
		return ledger.Begin(ctx, a.org, a.storePK, id, opsdomain.RequestHash(a.store, raw), opscontract.KindProductMutation, raw)
	}
	pending := func(raw []byte) {
		t.Helper()
		_, err := begin(key(), raw)
		var refusal *opscontract.Fail
		if !errors.As(err, &refusal) || refusal.Status != 409 || refusal.Code != opscontract.CodeSellerUnknown {
			t.Fatalf("unresolved target not blocked: %v", err)
		}
	}
	const product int64 = 6706622242
	const offer = "price-fence-concurrent"
	raw := body(product, offer, "price")

	// Hold the store's transaction lock so both normal connections contend before either insert.
	barrier, err := a.fixture.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer barrier.Rollback(context.Background())
	if _, err = barrier.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('ops-price:' || $1::bigint::text || ':' || $2::bigint::text,0))`, a.org, a.storePK); err != nil {
		t.Fatal(err)
	}
	type result struct {
		key string
		row opscontract.LedgerRow
		err error
	}
	start, results := make(chan struct{}), make(chan result, 2)
	for range 2 {
		id := key()
		go func() {
			<-start
			row, err := begin(id, raw)
			results <- result{id, row, err}
		}()
	}
	close(start)
	for {
		var waiters int
		if err := a.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='podhub_login_api' AND wait_event='advisory'`).Scan(&waiters); err != nil {
			t.Fatal(err)
		}
		if waiters == 2 {
			break
		}
		select {
		case early := <-results:
			t.Fatalf("price bypassed transaction barrier: %+v", early)
		case <-ctx.Done():
			t.Fatal("two price operations did not contend on the store lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := barrier.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var winner string
	for range 2 {
		got := <-results
		if got.err == nil && got.row.Inserted {
			if winner != "" {
				t.Fatal("two new operation IDs acquired the same target")
			}
			winner = got.key
		} else {
			var refusal *opscontract.Fail
			if !errors.As(got.err, &refusal) || refusal.Code != opscontract.CodeSellerUnknown {
				t.Fatalf("contending operation result: %v %+v", got.err, got.row)
			}
		}
	}
	if winner == "" {
		t.Fatal("no operation acquired target")
	}
	replayed, err := begin(winner, raw)
	if err != nil || replayed.Inserted || replayed.State != "dispatching" {
		t.Fatalf("original dispatching identity changed: %+v %v", replayed, err)
	}
	if err := ledger.MarkUnknown(ctx, a.org, a.storePK, winner, opsdomain.RequestHash(a.store, raw), opscontract.CodeSellerUnknown, "fixture interrupted", 60); err != nil {
		t.Fatal(err)
	}
	replayed, err = begin(winner, raw)
	if err != nil || replayed.Inserted || replayed.State != "result_unknown" {
		t.Fatalf("original unknown identity changed: %+v %v", replayed, err)
	}
	pending(body(product, "another-offer", "price"))
	pending(body(product+1, "  "+offer+"  ", "price"))
	if got, err := begin(key(), body(product+1, "unrelated-offer", "price")); err != nil || !got.Inserted {
		t.Fatalf("unrelated price was blocked: %+v %v", got, err)
	}
	if got, err := begin(key(), body(product, offer, "stock")); err != nil || !got.Inserted {
		t.Fatalf("other product action was blocked: %+v %v", got, err)
	}
	var count int
	if err := a.fixture.QueryRow(ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1 AND store_id=$2 AND request_body->>'kind'='price' AND request_body->'items'->0->>'product_id'=$3::bigint::text`, a.org, a.storePK, product).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected target wrote ledger rows: %d %v", count, err)
	}
	reconcile := func(want string) {
		t.Helper()
		reply := postJSON(t, a.handler, "/api/ops/console/reconcile", "", "", a.cookie)
		if reply.Code != http.StatusOK || !strings.Contains(reply.Body.String(), `"outcome":"`+want+`"`) {
			t.Fatalf("reconcile %d %s", reply.Code, reply.Body.String())
		}
	}
	reconcile("still_unknown")
	pending(raw)
	readMode.Store(1)
	reconcile("still_unknown")
	pending(raw)
	reconcile("conflict")
	if got, err := begin(key(), raw); err != nil || !got.Inserted {
		t.Fatalf("confirmed mismatch did not release price target: %+v %v", got, err)
	}
}
