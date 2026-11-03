package integration

import (
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestProductWorkspaceExportProductionRole(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	var orgA, orgB int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96311`).Scan(&orgA); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96312`).Scan(&orgB); err != nil {
		t.Fatal(err)
	}
	member := seedCompanyMember(t, f.ctx, f.fixture, orgA, 96312, "member", 2)
	storeA, storeHidden, storeOther := "11000000-0000-4000-8000-000000000001", "11000000-0000-4000-8000-000000000002", "11000000-0000-4000-8000-000000000003"
	seedCompanyStore(t, f.ctx, f.fixture, orgA, storeA, 1, "主店", &member)
	seedCompanyStore(t, f.ctx, f.fixture, orgA, storeHidden, 2, "未指派店", nil)
	seedCompanyStore(t, f.ctx, f.fixture, orgB, storeOther, 1, "其他组织", nil)
	var status int16
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO ozon_product_status(is_archived,status,status_name,moderate_status,validation_status,state)
		VALUES(false,'export-test','Export','approved','success','on_sale') RETURNING id`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO store_products(org_id,store_pk,product_id,offer_id,sku,name,price,stock_present,status_id,refreshed_at_ms)
		SELECT $1,s.id,n,'needle-'||n,1234567890123456789,'=formula',12.5,0,$3,1700000000000
		FROM organization_stores s CROSS JOIN generate_series(1,305) n WHERE s.uuid=$2::uuid`, orgA, storeA, status); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO store_products(org_id,store_pk,product_id,offer_id,name,status_id)
		SELECT org_id,id,999,'needle-hidden','隐藏店商品',$2 FROM organization_stores WHERE uuid=$1::uuid`, storeHidden, status); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO store_product_sync(org_id,store_id,refresh_generation,currency,last_full_sync_at_ms)
		VALUES($1,$2::uuid,1,'USD',1700000000000)`, orgA, storeA); err != nil {
		t.Fatal(err)
	}
	owner := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", ""))
	other := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96312@example.invalid","password":"original-password"}`, "", ""))
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET active_org_id=$1 WHERE id=96312`, orgA); err != nil {
		t.Fatal(err)
	}
	listed := f.request(http.MethodGet, "/api/workspaces/products?storeId="+storeA+"&limit=1", "", owner, "")
	var page struct {
		Rows []struct {
			SKU string `json:"sku"`
		} `json:"rows"`
	}
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &page) != nil || len(page.Rows) != 1 || page.Rows[0].SKU != "1234567890123456789" {
		t.Fatalf("product SKU text lost before selected export: %d %s", listed.Code, listed.Body.String())
	}
	for _, tc := range []struct {
		token string
		count int
	}{{owner, 307}, {other, 306}} {
		res := f.request(http.MethodGet, "/api/workspaces/products/export?status=on_sale&q=needle", "", tc.token, "")
		rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(res.Body.String(), "\uFEFF"))).ReadAll()
		if res.Code != http.StatusOK || err != nil || len(rows) != tc.count {
			t.Fatalf("full export status=%d rows=%d want=%d err=%v body=%s", res.Code, len(rows), tc.count, err, res.Body.String())
		}
		if rows[1][0] != "'=formula" || rows[1][2] != "'1234567890123456789" || rows[1][5] != "USD" || rows[1][8] != "2023-11-14T22:13:20Z" {
			t.Fatalf("CSV facts or injection guard: %v", rows[1])
		}
	}
	for _, path := range []string{
		"/api/workspaces/products/export?storeId=" + storeHidden,
		"/api/workspaces/products/export?storeId=" + storeOther,
	} {
		res := f.request(http.MethodGet, path, "", other, "")
		if res.Code != http.StatusNotFound {
			t.Fatalf("invisible export status=%d body=%s", res.Code, res.Body.String())
		}
	}
	for _, path := range []string{
		"/api/workspaces/products/export?status=bogus",
		"/api/workspaces/products/export?includeGone=bogus",
	} {
		if res := f.request(http.MethodGet, path, "", owner, ""); res.Code != http.StatusBadRequest {
			t.Fatalf("invalid request: %s status=%d body=%s", path, res.Code, res.Body.String())
		}
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO store_products(org_id,store_pk,product_id,offer_id,status_id)
		SELECT $1,s.id,n,'overflow-'||n,$3 FROM organization_stores s CROSS JOIN generate_series(1000,51000)n WHERE s.uuid=$2::uuid`, orgA, storeA, status); err != nil {
		t.Fatal(err)
	}
	if res := f.request(http.MethodGet, "/api/workspaces/products/export?q=overflow", "", owner, ""); res.Code != http.StatusRequestEntityTooLarge || strings.HasPrefix(res.Body.String(), "\uFEFF") {
		t.Fatalf("oversize export returned partial CSV: %d %s", res.Code, res.Body.String())
	}
	f.assertClean(t)
}
