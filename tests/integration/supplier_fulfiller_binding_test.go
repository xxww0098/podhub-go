package integration

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	delegatedomain "github.com/xxww0098/podhub-go/internal/delegate/domain"
	delegaterepo "github.com/xxww0098/podhub-go/internal/delegate/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestFactoryFulfillerBindingControlsDispatch(t *testing.T) {
	f := newFulfillerFixture(t, true)
	now := time.Now().UnixMilli()
	if err := f.portal.RevokeFulfiller(f.ctx, f.actor(), f.source, f.grant, now); err != nil {
		t.Fatal(err)
	}
	accounts, err := f.portal.ListAccounts(f.ctx, f.actor())
	if err != nil || len(accounts) != 1 || accounts[0].AccountUUID != f.accountUUID(t, f.user) {
		t.Fatalf("account picker: %+v %v", accounts, err)
	}
	assertBinding := func(bound bool) {
		t.Helper()
		dbs, err := f.portal.ListDbs(f.ctx, f.actor())
		if err != nil {
			t.Fatal(err)
		}
		for _, db := range dbs {
			if db.SourceID != f.source {
				continue
			}
			if (db.FulfillerEmail != nil) != bound || bound && *db.FulfillerEmail != accounts[0].Email {
				t.Fatalf("binding summary: %+v", db)
			}
			return
		}
		t.Fatal("factory missing from list")
	}
	assertBinding(false)
	for _, account := range []string{"missing-account", f.accountUUID(t, f.owner)} {
		if _, err := f.portal.GrantFulfiller(f.ctx, f.actor(), f.source, account, now); err == nil {
			t.Fatalf("accepted non-supplier account %q", account)
		}
	}
	order, binding, asset, line := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	f.exec(t, `INSERT INTO delegate_orders(order_id,org_id,store_id,posting_number,state,logistics,created_at_ms,updated_at_ms)
 VALUES($1::uuid,$2,$3::uuid,$1,'ready','{"shipment_date":"2099-01-01T00:00:00Z"}',1,1)`, order, f.org, f.store)
	f.exec(t, `INSERT INTO delegate_bindings(binding_id,org_id,store_id,offer_id,source_id,active,created_by,created_at_ms,updated_at_ms)
 VALUES($1::uuid,$2,$3::uuid,'FULFILLER-OFFER',$4,true,$5,1,1)`, binding, f.org, f.store, f.source, f.owner)
	f.exec(t, `INSERT INTO delegate_assets(asset_id,org_id,binding_id,object_key,sha256,bytes,mime,file_name,verified_at_ms,created_at_ms)
 VALUES($1::uuid,$2,$3::uuid,'binding-test',$4,10,'image/png','test.png',1,1)`, asset, f.org, binding, strings.Repeat("a", 64))
	f.exec(t, `INSERT INTO delegate_order_lines(line_id,org_id,order_id,offer_id,quantity,binding_id)
 VALUES($1::uuid,$2,$3::uuid,'FULFILLER-OFFER',1,$4::uuid)`, line, f.org, order, binding)
	repo := delegaterepo.New(f.pool, tenantx.BeginApp)
	cmd := delegatedomain.AdminCommand{OrderID: order, UserID: f.staff, NowMS: now, NewID: uuid.NewString}
	if _, err := repo.Dispatch(f.ctx, cmd, delegatedomain.DispatchInput{}); err == nil || !strings.Contains(err.Error(), "未绑定履约账号") {
		t.Fatalf("missing binding refusal: %v", err)
	}
	var count int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM delegate_dispatches WHERE order_id=$1::uuid`, order).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unbound factory received packets: %d %v", count, err)
	}
	grant, err := f.portal.GrantFulfiller(f.ctx, f.actor(), f.source, accounts[0].AccountUUID, now)
	if err != nil || grant.FulfillerID != f.grant {
		t.Fatalf("bind account: %+v %v", grant, err)
	}
	assertBinding(true)
	if _, err := repo.Dispatch(f.ctx, cmd, delegatedomain.DispatchInput{}); err != nil {
		t.Fatal(err)
	}
	var dispatch, recipient string
	if err := f.pool.QueryRow(f.ctx, `SELECT dispatch_id::text,fulfiller_id::text FROM delegate_dispatches WHERE order_id=$1::uuid`, order).Scan(&dispatch, &recipient); err != nil || recipient != grant.FulfillerID {
		t.Fatalf("dispatch recipient: %s %v", recipient, err)
	}
	if rec := f.request(t, f.user, http.MethodGet, "/api/supplier/dispatches/"+dispatch, ""); rec.Code != http.StatusOK {
		t.Fatalf("bound factory cannot read packet: %d %s", rec.Code, rec.Body.String())
	}
	if err := f.portal.RevokeFulfiller(f.ctx, f.actor(), f.source, grant.FulfillerID, now+1); err != nil {
		t.Fatal(err)
	}
	assertBinding(false)
}
