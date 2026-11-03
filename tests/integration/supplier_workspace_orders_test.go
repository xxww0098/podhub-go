package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	suppliercontract "github.com/xxww0098/podhub-go/internal/supplier/contract"
)

func TestSupplierWorkspaceDashboardAndPagination(t *testing.T) {
	f := newFulfillerFixture(t, false)
	future := time.Now().UTC().Add(48 * time.Hour).Format(time.RFC3339)
	near := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	f.exec(t, `WITH orders AS (
 INSERT INTO delegate_orders(order_id,org_id,store_id,posting_number,state,created_at_ms,updated_at_ms)
 SELECT gen_random_uuid(),$1,$2::uuid,'bulk-' || n,'dispatched',1,1 FROM generate_series(1,104) n
 RETURNING order_id,posting_number
)
INSERT INTO delegate_dispatches(dispatch_id,org_id,order_id,source_id,dispatch_no,payload,state,fulfiller_id,created_at_ms,updated_at_ms)
SELECT gen_random_uuid(),$1,order_id,$3,posting_number,
 jsonb_build_object('posting_number',posting_number,'logistics',jsonb_build_object('shipment_date',$5::text),
 'lines',jsonb_build_array(jsonb_build_object('name','普通商品','offer_id','FULFILLER-OFFER','quantity',1))),
 'dispatched',$4::uuid,1,1 FROM orders`, f.org, f.store, f.source, f.grant, future)
	urgent := f.dispatch(t)
	f.exec(t, `UPDATE delegate_dispatches SET nudge_count=1, payload=jsonb_set(payload,'{logistics}',jsonb_build_object('shipment_date',$2::text),true) WHERE dispatch_id=$1::uuid`, urgent, near)
	invalid := f.dispatch(t)
	f.exec(t, `UPDATE delegate_dispatches SET dispatch_no='special-needle', payload='{"logistics":{"shipment_date":"2026-02-31T01:02:03Z"},"lines":[{"name":"独特商品","offer_id":"FULFILLER-OFFER","quantity":1}]}' WHERE dispatch_id=$1::uuid`, invalid)
	noZone := f.dispatch(t)
	f.exec(t, `UPDATE delegate_dispatches SET payload=jsonb_set(payload,'{logistics}', '{"shipment_date":"2001-01-01T01:02:03"}'::jsonb,true) WHERE dispatch_id=$1::uuid`, noZone)
	nudged := f.dispatch(t)
	f.exec(t, `UPDATE delegate_dispatches SET state='accepted',nudge_count=1 WHERE dispatch_id=$1::uuid`, nudged)
	shipped := f.dispatch(t)
	f.exec(t, `UPDATE delegate_dispatches SET state='shipped',nudge_count=1 WHERE dispatch_id=$1::uuid`, shipped)

	otherSource := "src_other_workspace_" + uuid.NewString()
	f.exec(t, `INSERT INTO sc_factory_members(factory_id,user_id,created_by,created_at_ms) VALUES($1,$2,$3,1)`, f.source, f.user, f.staff)
	f.exec(t, `INSERT INTO sc_sources(source_id,name,factory_id,listed,created_at_ms,updated_at_ms) VALUES($1,$1,$2,false,1,1)`, otherSource, f.source)
	otherGrant, err := f.portal.GrantFulfiller(f.ctx, f.actor(), otherSource, f.accountUUID(t, f.user), time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	otherOrder, otherDispatch := uuid.NewString(), uuid.NewString()
	f.exec(t, `INSERT INTO delegate_orders(order_id,org_id,store_id,posting_number,state,created_at_ms,updated_at_ms) VALUES($1::uuid,$2,$3::uuid,$1,'dispatched',1,1)`, otherOrder, f.org, f.store)
	f.exec(t, `INSERT INTO delegate_dispatches(dispatch_id,org_id,order_id,source_id,dispatch_no,payload,state,fulfiller_id,created_at_ms,updated_at_ms)
 VALUES($1::uuid,$2,$3::uuid,$4,'other-only',jsonb_build_object('logistics',jsonb_build_object('shipment_date',$6::text),'lines','[]'::jsonb),'accepted',$5::uuid,1,1)`, otherDispatch, f.org, otherOrder, otherSource, otherGrant.FulfillerID, near)

	base := "/api/supplier/workspaces/" + f.source
	decode := func(path string, target any) {
		t.Helper()
		rec := f.request(t, f.user, http.MethodGet, path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), target); err != nil {
			t.Fatal(err)
		}
	}
	var dashboard struct {
		Data suppliercontract.DashboardData `json:"data"`
	}
	decode(base+"/dashboard", &dashboard)
	if got, want := dashboard.Data.Counts, (suppliercontract.DashboardCounts{Pending: 107, Producing: 1, Urgent: 2, Shipped: 1}); got != want {
		t.Fatalf("counts = %+v, want %+v", got, want)
	}
	if len(dashboard.Data.UrgentOrders) != 2 {
		t.Fatalf("urgent dashboard rows = %+v", dashboard.Data.UrgentOrders)
	}

	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 6; page++ {
		var got struct {
			Data suppliercontract.DispatchListData `json:"data"`
		}
		path := base + "/dispatches?view=pending"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		decode(path, &got)
		wantSize := 20
		if page == 5 {
			wantSize = 7
		}
		if len(got.Data.Dispatches) != wantSize || got.Data.HasMore != (page < 5) || (got.Data.Cursor == "") != (page == 5) || (cursor != "" && got.Data.Cursor == cursor) {
			t.Fatalf("page %d: %+v", page+1, got.Data)
		}
		cursor = got.Data.Cursor
		for _, row := range got.Data.Dispatches {
			if seen[row.DispatchID] || row.DispatchID == otherDispatch {
				t.Fatalf("duplicate or cross-workspace row %s", row.DispatchID)
			}
			seen[row.DispatchID] = true
		}
	}
	if len(seen) != 107 {
		t.Fatalf("got %d rows across pages", len(seen))
	}
	var searched struct {
		Data suppliercontract.DispatchListData `json:"data"`
	}
	decode(base+"/dispatches?view=pending&search="+url.QueryEscape("独特商品"), &searched)
	if len(searched.Data.Dispatches) != 1 || searched.Data.Dispatches[0].DispatchID != invalid {
		t.Fatalf("search = %+v", searched.Data)
	}

	for _, tc := range []struct {
		query string
		want  int
	}{
		{"view=urgent", 2},
		{"view=urgent&reason=deadline", 1},
		{"view=urgent&reason=nudge", 2},
		{"view=urgent&status=accepted", 1},
		{"view=urgent&status=dispatched&reason=nudge", 1},
		{"view=urgent&status=accepted&reason=deadline", 0},
	} {
		var got struct {
			Data suppliercontract.DispatchListData `json:"data"`
		}
		decode(base+"/dispatches?"+tc.query, &got)
		if len(got.Data.Dispatches) != tc.want {
			t.Errorf("%s: got %d, want %d", tc.query, len(got.Data.Dispatches), tc.want)
		}
	}
	// Put more than one page of deadline-only orders before the undated nudge;
	// filtering after pagination would lose that accepted order.
	bulkNear := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
	f.exec(t, `UPDATE delegate_dispatches SET payload=jsonb_set(payload,'{logistics}',jsonb_build_object('shipment_date',$2::text),true) WHERE source_id=$1 AND dispatch_no LIKE 'bulk-%'`, f.source, bulkNear)
	for _, query := range []string{"view=urgent&reason=nudge", "view=urgent&status=accepted"} {
		var got struct {
			Data suppliercontract.DispatchListData `json:"data"`
		}
		decode(base+"/dispatches?"+query, &got)
		found := false
		for _, row := range got.Data.Dispatches {
			found = found || row.DispatchID == nudged
		}
		if !found || got.Data.HasMore {
			t.Errorf("filter before pagination %s: %+v", query, got.Data)
		}
	}
	var other struct {
		Data suppliercontract.DashboardData `json:"data"`
	}
	decode("/api/supplier/workspaces/"+otherSource+"/dashboard", &other)
	if got, want := other.Data.Counts, (suppliercontract.DashboardCounts{Producing: 1, Urgent: 1}); got != want {
		t.Fatalf("other workspace counts = %+v, want %+v", got, want)
	}
	for _, path := range []string{
		base + "/dispatches?view=pending&status=accepted",
		base + "/dispatches?view=urgent&reason=unknown",
		base + "/dispatches?view=pending&cursor=" + url.QueryEscape("0|invalid|"+urgent),
	} {
		if rec := f.request(t, f.user, http.MethodGet, path, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("invalid %s = %d %s", path, rec.Code, rec.Body.String())
		}
	}
	if rec := f.request(t, f.user, http.MethodGet, "/api/supplier/dispatches", ""); rec.Code != http.StatusNotFound {
		t.Errorf("unscoped list = %d", rec.Code)
	}
	if rec := f.request(t, f.user, http.MethodGet, fmt.Sprintf("/api/supplier/workspaces/%s/dashboard", "not-owned"), ""); rec.Code != http.StatusNotFound {
		t.Errorf("unauthorized workspace = %d %s", rec.Code, rec.Body.String())
	}
}
