package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	admincontract "github.com/xxww0098/podhub-go/internal/admin/contract"
	adminsupplier "github.com/xxww0098/podhub-go/internal/admin/supplier/repo"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	supplierhttp "github.com/xxww0098/podhub-go/internal/supplier/http"
	supplierrepo "github.com/xxww0098/podhub-go/internal/supplier/repo"
	supplierservice "github.com/xxww0098/podhub-go/internal/supplier/service"
)

type fulfillerSession struct{ user int64 }

func (s fulfillerSession) Resolve(*http.Request) (*supplierhttp.Principal, *supplierhttp.Refusal, error) {
	return &supplierhttp.Principal{UserID: s.user}, nil, nil
}

type fulfillerFixture struct {
	ctx                     context.Context
	pool                    *pgxpool.Pool
	org, owner, user, staff int64
	source, store, grant    string
	portal                  adminsupplier.Portal
}

func newFulfillerFixture(t *testing.T, legacyMember bool) fulfillerFixture {
	t.Helper()
	f := fulfillerFixture{ctx: context.Background(), source: "src_fulfiller_" + uuid.NewString(), store: uuid.NewString()}
	f.pool = migratedPool(t, f.ctx)
	for _, u := range []struct {
		id   *int64
		kind string
		role string
	}{{&f.owner, "platform", "user"}, {&f.staff, "platform", "super_admin"}, {&f.user, "supplier", "user"}} {
		publicID := uuid.NewString()
		if err := f.pool.QueryRow(f.ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,account_kind,created_at,updated_at)
 VALUES($1,$2,'x',$3,'Synthetic','/workspace','','free',$4,clock_timestamp(),clock_timestamp()) RETURNING id`, publicID, publicID+"@example.invalid", u.role, u.kind).Scan(u.id); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.pool.QueryRow(f.ctx, `INSERT INTO organizations(owner_user_id,name,plan,created_at,updated_at)
 VALUES($1,'Synthetic fulfiller seller','free',clock_timestamp(),clock_timestamp()) RETURNING id`, f.owner).Scan(&f.org); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2::uuid,1,'Synthetic store')`, f.org, f.store)
	f.exec(t, `INSERT INTO workspace_wallets(org_id,balance_microfen,held_microfen) VALUES($1,1000000000,0)`, f.org)
	f.exec(t, `INSERT INTO sc_factories(factory_id,name,created_at_ms,updated_at_ms) VALUES($1,$1,1,1)`, f.source)
	f.exec(t, `INSERT INTO sc_sources(source_id,name,factory_id,listed,created_at_ms,updated_at_ms) VALUES($1,$1,$1,false,1,1)`, f.source)
	f.exec(t, `INSERT INTO sc_factory_members(factory_id,user_id,created_by,created_at_ms) VALUES($1,$2,$3,1)`, f.source, f.user, f.staff)
	f.exec(t, `INSERT INTO sc_products(product_id,source_id,title,published,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES('fulfiller_product',$1,'Synthetic',false,1,1,'synthetic')`, f.source)
	f.exec(t, `INSERT INTO sc_skus(sku_id,product_id,platform_code,title,published,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES('fulfiller_sku','fulfiller_product','FULFILLER-OFFER','Synthetic',false,1,1,'synthetic')`)
	f.exec(t, `INSERT INTO sc_source_offers(source_id,sku_id,cost_cents,created_at_ms,updated_at_ms) VALUES($1,'fulfiller_sku',20,1,1)`, f.source)
	seedMatchingLease(t, f.ctx, f.pool, "admin", "synthetic fulfiller access")
	f.portal = adminsupplier.Portal{Pool: f.pool, Begin: tenantx.BeginApp}
	grant, err := f.portal.GrantFulfiller(f.ctx, f.actor(), f.source, f.accountUUID(t, f.user), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	f.grant = grant.FulfillerID
	if !legacyMember {
		f.exec(t, `DELETE FROM sc_factory_members WHERE factory_id=$1 AND user_id=$2`, f.source, f.user)
	}
	return f
}

func (f fulfillerFixture) accountUUID(t *testing.T, userID int64) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(f.ctx, `SELECT public_id FROM account_users WHERE id=$1`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f fulfillerFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func (f fulfillerFixture) actor() admincontract.Actor {
	return admincontract.Actor{UserID: f.staff, Role: "super_admin"}
}

func (f fulfillerFixture) dispatch(t *testing.T) string {
	t.Helper()
	order, dispatch := uuid.NewString(), uuid.NewString()
	f.exec(t, `INSERT INTO delegate_orders(order_id,org_id,store_id,posting_number,state,created_at_ms,updated_at_ms)
 VALUES($1::uuid,$2,$3::uuid,$4,'dispatched',1,1)`, order, f.org, f.store, order)
	f.exec(t, `INSERT INTO delegate_dispatches(dispatch_id,org_id,order_id,source_id,dispatch_no,payload,state,fulfiller_id,created_at_ms,updated_at_ms)
 VALUES($1::uuid,$2,$3::uuid,$4,$1,'{"lines":[{"offer_id":"FULFILLER-OFFER","quantity":1}]}'::jsonb,'dispatched',$5::uuid,1,1)`, dispatch, f.org, order, f.source, f.grant)
	return dispatch
}

func (f fulfillerFixture) request(t *testing.T, user int64, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	supplierhttp.Mount(router, supplierhttp.Deps{Session: fulfillerSession{user: user}, Actions: supplierservice.New(supplierrepo.New(f.pool, tenantx.BeginApp).WithMoney(billingrepo.HoldTx, billingrepo.SettleTx))})
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestSupplierFulfillerGrantIsPortalAuthority(t *testing.T) {
	for _, legacy := range []bool{true, false} {
		t.Run(fmt.Sprintf("legacy_member=%v", legacy), func(t *testing.T) {
			f := newFulfillerFixture(t, legacy)
			dispatch := f.dispatch(t)
			for _, path := range []string{"/api/supplier/me", "/api/supplier/workspaces/" + f.source + "/dispatches", "/api/supplier/dispatches/" + dispatch} {
				rec := f.request(t, f.user, "GET", path, "")
				if rec.Code != 200 {
					t.Errorf("active fulfiller %s: %d %s", path, rec.Code, rec.Body.String())
				}
				if path == "/api/supplier/me" && !strings.Contains(rec.Body.String(), f.source) {
					t.Errorf("own unlisted source missing: %s", rec.Body.String())
				}
				if path != "/api/supplier/me" && !strings.Contains(rec.Body.String(), `"payout_cents":20`) {
					t.Errorf("own packet quote missing: %s", rec.Body.String())
				}
			}
			for _, action := range []string{"accept", "reject"} {
				dispatch := f.dispatch(t)
				rec := f.request(t, f.user, "POST", "/api/supplier/dispatches/"+dispatch+"/"+action, `{"reason":"synthetic refusal"}`)
				if rec.Code != 200 {
					t.Errorf("active fulfiller %s: %d %s", action, rec.Code, rec.Body.String())
				}
				var state string
				if err := f.pool.QueryRow(f.ctx, `SELECT state FROM delegate_dispatches WHERE dispatch_id=$1::uuid`, dispatch).Scan(&state); err != nil {
					t.Fatal(err)
				}
				wantState := map[string]string{"accept": "accepted", "reject": "rejected"}[action]
				if state != wantState {
					t.Errorf("persisted %s state = %s, want %s", action, state, wantState)
				}
				if action == "accept" {
					var cents, micro, held int64
					if err := f.pool.QueryRow(f.ctx, `SELECT s.amount_cents,s.amount_microfen,w.held_microfen FROM delegate_settlements s JOIN workspace_wallets w ON w.org_id=$2 WHERE s.dispatch_id=$1::uuid`, dispatch, f.org).Scan(&cents, &micro, &held); err != nil {
						t.Fatal(err)
					}
					if cents != 20 || micro != 20000000 || held != micro {
						t.Errorf("accepted quote/hold cents=%d micro=%d held=%d", cents, micro, held)
					}
				}
			}
		})
	}
}

func TestSupplierRevokedFulfillerKeepsPinnedHistory(t *testing.T) {
	f := newFulfillerFixture(t, true)
	dispatch := f.dispatch(t)
	if err := f.portal.RevokeFulfiller(f.ctx, f.actor(), f.source, f.grant, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `DELETE FROM sc_factory_members WHERE user_id=$1`, f.user)
	for _, path := range []string{"/api/supplier/me", "/api/supplier/workspaces/" + f.source + "/dispatches", "/api/supplier/dispatches/" + dispatch} {
		rec := f.request(t, f.user, "GET", path, "")
		if rec.Code != 200 || (path != "/api/supplier/me" && !strings.Contains(rec.Body.String(), dispatch)) {
			t.Errorf("retained fulfiller history %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	for _, action := range []string{"accept", "reject"} {
		rec := f.request(t, f.user, "POST", "/api/supplier/dispatches/"+dispatch+"/"+action, `{"reason":"synthetic refusal"}`)
		if rec.Code != 404 {
			t.Errorf("revoked fulfiller %s: %d %s", action, rec.Code, rec.Body.String())
		}
	}
}

func TestSupplierFulfillerQuoteDoesNotGrantCatalogOrFunds(t *testing.T) {
	f := newFulfillerFixture(t, false)
	dispatch := f.dispatch(t)
	f.exec(t, `INSERT INTO supplier_wallets(source_id,balance_microfen,held_microfen,updated_at_ms) VALUES($1,100,0,1)`, f.source)
	err := db.InTx(f.ctx, f.pool, db.Supplier(f.user), func(tx pgx.Tx) error {
		var sources, products, skus, offers, wallets int
		if err := tx.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM sc_sources WHERE source_id=$1),(SELECT count(*) FROM sc_products WHERE source_id=$1),(SELECT count(*) FROM sc_skus WHERE sku_id='fulfiller_sku'),(SELECT count(*) FROM sc_source_offers WHERE source_id=$1),(SELECT count(*) FROM supplier_wallets WHERE source_id=$1)`, f.source).Scan(&sources, &products, &skus, &offers, &wallets); err != nil {
			return err
		}
		if sources != 0 || products != 0 || skus != 0 || offers != 0 || wallets != 0 {
			t.Errorf("fulfiller gained direct source/catalog/funds reads: %d %d %d %d %d", sources, products, skus, offers, wallets)
		}
		var lines, missing, cents int64
		if err := tx.QueryRow(f.ctx, `SELECT * FROM supplier_dispatch_quote($1::uuid)`, dispatch).Scan(&lines, &missing, &cents); err != nil {
			return err
		}
		if lines != 1 || missing != 0 || cents != 20 {
			t.Errorf("own pinned quote = %d %d %d", lines, missing, cents)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSupplierFulfillerPacketIsolation(t *testing.T) {
	for _, kind := range []string{"legacy_member", "other_source_fulfiller", "replacement_fulfiller", "unset_supplier"} {
		t.Run(kind, func(t *testing.T) {
			f := newFulfillerFixture(t, false)
			dispatch := f.dispatch(t)
			var other int64
			id := uuid.NewString()
			if err := f.pool.QueryRow(f.ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,account_kind,created_at,updated_at) VALUES($1,$2,'x','user','Other','/workspace','','free','supplier',clock_timestamp(),clock_timestamp()) RETURNING id`, id, id+"@example.invalid").Scan(&other); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "legacy_member":
				f.exec(t, `INSERT INTO sc_factory_members(factory_id,user_id,created_by,created_at_ms) VALUES($1,$2,$3,1)`, f.source, other, f.staff)
			case "other_source_fulfiller", "replacement_fulfiller":
				source := f.source
				if kind == "other_source_fulfiller" {
					source = "src_other_" + uuid.NewString()
					f.exec(t, `INSERT INTO sc_factories(factory_id,name,created_at_ms,updated_at_ms) VALUES($1,$1,1,1)`, source)
					f.exec(t, `INSERT INTO sc_sources(source_id,name,factory_id,listed,created_at_ms,updated_at_ms) VALUES($1,$1,$1,false,1,1)`, source)
				} else if err := f.portal.RevokeFulfiller(f.ctx, f.actor(), f.source, f.grant, time.Now().UnixMilli()); err != nil {
					t.Fatal(err)
				}
				f.exec(t, `INSERT INTO sc_factory_members(factory_id,user_id,created_by,created_at_ms) VALUES($1,$2,$3,1)`, source, other, f.staff)
				if _, err := f.portal.GrantFulfiller(f.ctx, f.actor(), source, f.accountUUID(t, other), time.Now().UnixMilli()); err != nil {
					t.Fatal(err)
				}
			}
			if kind != "unset_supplier" {
				for _, action := range []string{"", "/accept", "/reject"} {
					method := "POST"
					if action == "" {
						method = "GET"
					}
					rec := f.request(t, other, method, "/api/supplier/dispatches/"+dispatch+action, `{"reason":"synthetic refusal"}`)
					want := 404
					if rec.Code != want {
						t.Errorf("other user %s = %d %s, want %d", action, rec.Code, rec.Body.String(), want)
					}
				}
				rec := f.request(t, other, "GET", "/api/supplier/workspaces/"+f.source+"/dispatches", "")
				if strings.Contains(rec.Body.String(), dispatch) {
					t.Errorf("list leaked another user's packet: %s", rec.Body.String())
				}
			}
			session := db.Supplier(other)
			if kind == "unset_supplier" {
				session = db.AppRole()
			}
			if err := db.InTx(f.ctx, f.pool, session, func(tx pgx.Tx) error {
				var lines, missing, cents int64
				if err := tx.QueryRow(f.ctx, `SELECT * FROM supplier_dispatch_quote($1::uuid)`, dispatch).Scan(&lines, &missing, &cents); err != nil {
					return err
				}
				if lines != 0 || missing != 0 || cents != 0 {
					t.Errorf("quote leaked another user's packet: %d %d %d", lines, missing, cents)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSupplierFulfillerMissingCostRollsBack(t *testing.T) {
	f := newFulfillerFixture(t, false)
	dispatch := f.dispatch(t)
	f.exec(t, `DELETE FROM sc_source_offers WHERE source_id=$1`, f.source)
	rec := f.request(t, f.user, "POST", "/api/supplier/dispatches/"+dispatch+"/accept", `{}`)
	if rec.Code != 409 {
		t.Fatalf("missing cost acceptance = %d %s, want 409", rec.Code, rec.Body.String())
	}
	var state string
	var held int64
	var settlements, ledger, audits int
	if err := f.pool.QueryRow(f.ctx, `SELECT d.state,w.held_microfen,
 (SELECT count(*) FROM delegate_settlements WHERE dispatch_id=d.dispatch_id),
 (SELECT count(*) FROM wallet_ledger WHERE org_id=$2),
 (SELECT count(*) FROM audit_logs WHERE entity_type='delegate_dispatch' AND entity_id=$1)
 FROM delegate_dispatches d JOIN workspace_wallets w ON w.org_id=$2 WHERE d.dispatch_id=$1::uuid`, dispatch, f.org).Scan(&state, &held, &settlements, &ledger, &audits); err != nil {
		t.Fatal(err)
	}
	if state != "dispatched" || held != 0 || settlements != 0 || ledger != 0 || audits != 0 {
		t.Errorf("failed acceptance persisted state=%s held=%d settlements=%d ledger=%d audits=%d", state, held, settlements, ledger, audits)
	}
}
