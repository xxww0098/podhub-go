package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/app"
	opsdomain "github.com/xxww0098/podhub-go/internal/ops/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestOpsPromotionsNormalAPIPersistenceAndIsolation(t *testing.T) {
	var mode, writes, reads atomic.Int32
	var accepted atomic.Bool
	var targetID atomic.Int64
	targetID.Store(41)
	product := func(id int64) map[string]any {
		return map[string]any{
			"id": id, "price": map[string]string{"amount": "62.01", "currency": "CNY"}, "action_price": map[string]string{"amount": "62.01", "currency": "CNY"}, "max_action_price": map[string]string{"amount": "70.00", "currency": "CNY"}, "current_boost": 12.5, "is_quarantined": false,
		}
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/seller/info" && r.URL.Path != "/v1/roles" && (r.Header.Get("Client-Id") != "fixture-promotion-client" || r.Header.Get("Api-Key") != "fixture-promotion-key") {
			t.Error("unbound promotion credential")
		}
		respond := func(body any) {
			if err := json.NewEncoder(w).Encode(body); err != nil {
				t.Error(err)
			}
		}
		switch r.URL.Path {
		case "/v1/seller/info":
			respond(map[string]any{"company": map[string]string{"name": "Promotion fixture"}})
		case "/v1/roles":
			respond(map[string]any{"roles": []any{map[string]any{"name": "test", "methods": []string{"/v1/actions", "/v2/actions/products", "/v2/actions/candidates", "/v1/actions/products/update"}}}})
		case "/v1/actions":
			reads.Add(1)
			if r.Method != "GET" {
				t.Error("actions method")
			}
			freeze := ""
			if mode.Load() == 3 {
				freeze = "2026-10-01T00:00:00Z"
			}
			respond(map[string]any{"result": []any{map[string]any{"id": 7, "title": "Runtime campaign", "action_type": "ELASTIC_BOOSTING", "freeze_date": freeze, "date_end": "2030-01-01T00:00:00Z", "is_participating": accepted.Load(), "potential_products_count": 2, "participating_products_count": 1}}})
		case "/v2/actions/products", "/v2/actions/candidates":
			reads.Add(1)
			rows := []any{}
			if r.URL.Path == "/v2/actions/products" && accepted.Load() {
				rows = append(rows, product(targetID.Load()))
			}
			if r.URL.Path == "/v2/actions/candidates" && !accepted.Load() {
				rows = append(rows, product(targetID.Load()))
				if mode.Load() == 4 {
					rows = append(rows, product(targetID.Load()+1))
				}
			}
			respond(map[string]any{"products": rows, "total": len(rows), "last_id": "terminal-nonempty-cursor"})
		case "/v3/product/info/list":
			reads.Add(1)
			var req struct {
				IDs []int64 `json:"product_id"`
			}
			if json.NewDecoder(r.Body).Decode(&req) != nil {
				t.Error("details body")
			}
			rows := []any{}
			for _, id := range req.IDs {
				rows = append(rows, map[string]any{"id": id, "offer_id": fmt.Sprintf("promotion-%d", id), "name": fmt.Sprintf("Seller product %d", id), "sku": "18446744073709551615"})
			}
			respond(map[string]any{"items": rows})
		case "/v5/product/info/prices":
			reads.Add(1)
			var req struct {
				Filter struct {
					IDs []int64 `json:"product_id"`
				} `json:"filter"`
			}
			if json.NewDecoder(r.Body).Decode(&req) != nil {
				t.Error("prices body")
			}
			rows := []any{}
			for _, id := range req.Filter.IDs {
				if mode.Load() == 4 && accepted.Load() && id == targetID.Load()+1 {
					t.Error("explicit rejection was included in readback")
				}
				price := "62.0100"
				if mode.Load() == 2 && accepted.Load() {
					price = "60.00"
				}
				rows = append(rows, map[string]any{"product_id": id, "offer_id": fmt.Sprintf("promotion-%d", id), "price": map[string]any{"price": json.Number(price), "currency_code": "CNY"}})
			}
			respond(map[string]any{"items": rows, "total": len(rows), "total_items": len(rows), "cursor": "terminal-price-cursor"})
		case "/v1/actions/products/update":
			writes.Add(1)
			accepted.Store(true)
			if mode.Load() == 1 {
				respond(map[string]any{})
				return
			}
			var req struct {
				ActionID int64 `json:"action_id"`
				Products []struct {
					ID    int64                             `json:"product_id"`
					Price struct{ Amount, Currency string } `json:"action_price"`
					Stock json.RawMessage                   `json:"stock"`
				} `json:"products"`
			}
			if json.NewDecoder(r.Body).Decode(&req) != nil || req.ActionID != 7 || len(req.Products) == 0 {
				t.Error("promotion payload")
			}
			for _, row := range req.Products {
				if row.Price.Amount != "62.01" || row.Price.Currency != "CNY" || len(row.Stock) != 0 {
					t.Error("promotion exact money/stock lost")
				}
			}
			rejected := []any{}
			if mode.Load() == 4 {
				rejected = append(rejected, map[string]any{"product_id": targetID.Load() + 1, "reason": "price rejected"})
			}
			respond(map[string]any{"active_product_ids": []string{fmt.Sprint(targetID.Load())}, "deactivated_product_ids": []string{}, "rejected": rejected, "warnings": []any{}})
		default:
			t.Errorf("unexpected promotion upstream path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	t.Setenv("CLOUD_SELLER_EGRESS_ROUTES", "direct")
	a := newPriceAPI(t, "fixture-promotion-client", "fixture-promotion-key", upstream.URL+"/")
	command := func(op string, partial bool) string {
		items := []any{map[string]any{"product_id": targetID.Load(), "offer_id": fmt.Sprintf("promotion-%d", targetID.Load()), "action_price": "62.01", "currency_code": "CNY", "stock": 0}}
		if partial {
			items = append(items, map[string]any{"product_id": targetID.Load() + 1, "offer_id": fmt.Sprintf("promotion-%d", targetID.Load()+1), "action_price": "62.01", "currency_code": "CNY", "stock": 0})
		}
		raw, _ := json.Marshal(map[string]any{"store_id": a.store, "operation_id": op, "request": map[string]any{"kind": "promotion_join", "action_id": 7, "action_type": "ELASTIC_BOOSTING", "items": items}})
		return string(raw)
	}
	readBody := fmt.Sprintf(`{"store_id":%q,"product_ids":[],"action_id":7,"participating":false}`, a.store)
	beforeAnonymous := reads.Load()
	anonymous := postJSON(t, a.handler, "/api/ops/products/promotions", readBody, "", "")
	if anonymous.Code != 401 || reads.Load() != beforeAnonymous {
		t.Fatalf("anonymous catalog read: %d %s", anonymous.Code, anonymous.Body.String())
	}
	page := postJSON(t, a.handler, "/api/ops/products/promotions", readBody, "", a.cookie)
	if page.Code != 200 || !strings.Contains(page.Body.String(), `"sku":"18446744073709551615"`) || !strings.Contains(page.Body.String(), `"stock":null`) || !strings.Contains(page.Body.String(), `"next_cursor":null`) {
		t.Fatalf("normal-role page: %d %s", page.Code, page.Body.String())
	}
	closed := postJSON(t, a.handler, "/api/ops/products/mutate", command(uuid.NewString(), false), "", a.cookie)
	if closed.Code != 503 || writes.Load() != 0 {
		t.Fatalf("closed gate HTTP%d writes%d", closed.Code, writes.Load())
	}
	var count int
	if err := a.fixture.QueryRow(context.Background(), `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, a.org).Scan(&count); err != nil || count != 0 {
		t.Fatal("closed gate inserted ledger", err, count)
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	a.handler = app.Handler(a.pool)
	for n, tc := range []struct {
		name   string
		mode   int32
		status int
		state  string
		write  bool
	}{
		{"confirmed success", 0, 200, "settled", true},
		{"incomplete ACK", 1, 409, "result_unknown", true},
		{"card readback differs", 2, 409, "result_unknown", true},
		{"frozen preflight", 3, 400, "settled", false},
		{"confirmed partial rejection", 4, 200, "settled", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mode.Store(tc.mode)
			targetID.Store(41 + int64(n)*10)
			accepted.Store(false)
			op := uuid.NewString()
			body := command(op, tc.mode == 4)
			before := writes.Load()
			response := postJSON(t, a.handler, "/api/ops/products/mutate", body, "", a.cookie)
			wantWrites := before
			if tc.write {
				wantWrites++
			}
			if response.Code != tc.status || writes.Load() != wantWrites {
				t.Fatalf("HTTP%d body=%s writes%d", response.Code, response.Body.String(), writes.Load())
			}
			if tc.mode == 4 && (!strings.Contains(response.Body.String(), `"succeeded":false`) || !strings.Contains(response.Body.String(), "price rejected")) {
				t.Fatal("partial rejection was hidden", response.Body.String())
			}
			var state string
			var responseStatus *int
			if err := a.fixture.QueryRow(context.Background(), `SELECT state,response_status FROM seller_upstream_writes WHERE org_id=$1 AND store_id=$2 AND idempotency_key=$3`, a.org, a.storePK, opsdomain.ProductKey(a.store, op)).Scan(&state, &responseStatus); err != nil || state != tc.state || tc.state == "result_unknown" && responseStatus != nil {
				t.Fatalf("state=%s status=%v err=%v", state, responseStatus, err)
			}
			beforeReads := reads.Load()
			mode.Store(3)
			replay := postJSON(t, a.handler, "/api/ops/products/mutate", body, "", a.cookie)
			if replay.Code != tc.status || reads.Load() != beforeReads || writes.Load() != wantWrites {
				t.Fatalf("replay reran admission reads/write: HTTP%d reads%d/%d writes%d/%d body=%s", replay.Code, reads.Load(), beforeReads, writes.Load(), wantWrites, replay.Body.String())
			}
			if tc.state == "result_unknown" {
				for _, blockedBody := range []string{
					command(uuid.NewString(), false),
					strings.Replace(command(uuid.NewString(), false), `"action_id":7`, `"action_id":8`, 1),
					fmt.Sprintf(`{"operation_id":%q,"store_id":%q,"request":{"kind":"price","items":[{"product_id":%d,"offer_id":%q,"price":"62.02","old_price":"0","currency_code":"CNY"}]}}`, uuid.NewString(), a.store, targetID.Load(), fmt.Sprintf("promotion-%d", targetID.Load())),
					fmt.Sprintf(`{"operation_id":%q,"store_id":%q,"request":{"kind":"promotion_leave","action_id":8,"action_type":"ELASTIC_BOOSTING","product_ids":[%d],"exit_prices":[{"product_id":%d,"exit_price":"80.00","currency_code":"CNY"}]}}`, uuid.NewString(), a.store, targetID.Load(), targetID.Load()),
				} {
					blocked := postJSON(t, a.handler, "/api/ops/products/mutate", blockedBody, "", a.cookie)
					if blocked.Code != 409 || !strings.Contains(blocked.Body.String(), `"code":"seller_result_unknown"`) || reads.Load() != beforeReads || writes.Load() != wantWrites {
						t.Fatalf("pending price target bypassed: HTTP%d %s", blocked.Code, blocked.Body.String())
					}
				}
				var rows int
				if err := a.fixture.QueryRow(context.Background(), `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1 AND request_body->'items' @> $2::jsonb`, a.org, fmt.Sprintf(`[{"product_id":%d}]`, targetID.Load())).Scan(&rows); err != nil || rows != 1 {
					t.Fatalf("blocked key inserted ledger: rows=%d err=%v", rows, err)
				}
			}
		})
	}
	mode.Store(0)
	foreign := postJSON(t, app.Handler(a.fixture), "/api/auth/register", `{"email":"promotion-foreign@example.invalid","password":"correct-horse","name":"Foreign"}`, "promotion-foreign-register", "")
	if foreign.Code != 200 {
		t.Fatalf("foreign registration: %d %s", foreign.Code, foreign.Body.String())
	}
	foreignCookie := sessionCookie(foreign)
	beforeReads, beforeWrites := reads.Load(), writes.Load()
	foreignRead := postJSON(t, a.handler, "/api/ops/products/promotions", readBody, "", foreignCookie)
	foreignWrite := postJSON(t, a.handler, "/api/ops/products/mutate", command(uuid.NewString(), false), "", foreignCookie)
	if foreignRead.Code != 404 || foreignWrite.Code != 404 || reads.Load() != beforeReads || writes.Load() != beforeWrites {
		t.Fatalf("cross-tenant access: read=%d write=%d", foreignRead.Code, foreignWrite.Code)
	}
	var foreignUser, foreignOrg int64
	if err := a.fixture.QueryRow(context.Background(), `SELECT u.id,o.id FROM account_users u JOIN organizations o ON o.owner_user_id=u.id WHERE u.email='promotion-foreign@example.invalid'`).Scan(&foreignUser, &foreignOrg); err != nil {
		t.Fatal(err)
	}
	tx, err := tenantx.BeginApp(context.Background(), a.pool.Begin, foreignOrg)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(context.Background(), `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, a.org).Scan(&count); err != nil || count != 0 {
		t.Fatal("cross-tenant promotion ledger visible", err, count)
	}
	_ = tx.Rollback(context.Background())
	if _, err := a.fixture.Exec(context.Background(), `INSERT INTO organization_members(org_id,user_id,role,status,display_name,join_order,created_at,updated_at) VALUES($1,$2,'member','active','Promotion member',2,clock_timestamp(),clock_timestamp())`, a.org, foreignUser); err != nil {
		t.Fatal(err)
	}
	switched := postJSON(t, a.handler, "/api/workspaces/switch", fmt.Sprintf(`{"workspace_id":%d}`, a.org), "", foreignCookie)
	if switched.Code != 200 {
		t.Fatalf("member workspace switch: %d %s", switched.Code, switched.Body.String())
	}
	memberWrite := postJSON(t, a.handler, "/api/ops/products/mutate", command(uuid.NewString(), false), "", foreignCookie)
	if memberWrite.Code != 404 || reads.Load() != beforeReads || writes.Load() != beforeWrites {
		t.Fatalf("unassigned member mutation: %d %s", memberWrite.Code, memberWrite.Body.String())
	}
	var role string
	if a.pool.QueryRow(context.Background(), `SELECT current_setting('role')`).Scan(&role) != nil || role != "none" {
		t.Fatal("API role leaked")
	}
}
