package mcprepo

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	mcphttp "github.com/xxww0098/podhub-go/internal/mcp/http"
	mcpsvc "github.com/xxww0098/podhub-go/internal/mcp/service"
)

func TestListingStateRequiresVisibleExactStoreAndLiveGrant(t *testing.T) {
	pool, ctx := parityDB(t)
	first, name := seedGrant(t, ctx, pool, "listing-state-a")
	other, _ := seedGrant(t, ctx, pool, "listing-state-b")
	card, row, intent := uuid.NewString(), uuid.NewString(), uuid.NewString()
	var store string
	if err := pool.QueryRow(ctx, `INSERT INTO organization_stores(org_id,create_order,name) VALUES($1,1,'test') RETURNING uuid::text`, first.OrgID).Scan(&store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO listing_cards(id,org_id,title,store_id) VALUES($1::uuid,$2,'test',$3::uuid)`, card, first.OrgID, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO listing_rows(id,org_id,card_id,store_id,payload) VALUES($1::uuid,$2,$3::uuid,$4::uuid,'{"source":{"fileName":"test.png","sha256":"test"}}')`, row, first.OrgID, card, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO submission_intents(id,org_id,store_id,listing_row_id,row_revision,client_operation_id,request_hash,state,reconciliation_outcome) VALUES($1::uuid,$2,$3::uuid,$4::uuid,1,'op','hash','accepted','{"importTask":{"status":"imported"},"found":{"productId":42}}')`, intent, first.OrgID, store, row); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM submission_intents WHERE id=$1::uuid`, intent)
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE id=$1::uuid`, row)
		_, _ = pool.Exec(ctx, `DELETE FROM listing_cards WHERE id=$1::uuid`, card)
		_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE uuid=$1::uuid`, store)
	})
	repo := New(pool)
	begin := func(g domain.Grant) domain.Claim {
		t.Helper()
		version, err := domain.Version(g)
		if err != nil {
			t.Fatal(err)
		}
		started, err := repo.Begin(ctx, g, uuid.NewString(), strings.Repeat("a", 64), version)
		if err != nil {
			t.Fatal(err)
		}
		return started.Claim
	}
	claim := begin(first)
	data, err := repo.ListingState(ctx, first, claim, card, row, store)
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		RowID  string `json:"rowId"`
		Intent struct {
			State, ImportStatus string
			ProductID           int `json:"productId"`
		} `json:"intent"`
	}
	if err := json.Unmarshal(data, &value); err != nil || value.RowID != row || value.Intent.State != "accepted" || value.Intent.ImportStatus != "imported" || value.Intent.ProductID != 42 {
		t.Fatalf("unexpected result %s, %v", data, err)
	}
	version, err := domain.Version(first)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	mcphttp.Mount(router, mcphttp.Deps{Handler: mcpsvc.New(repo)})
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{
		"name": "execute", "arguments": map[string]any{"executionId": uuid.NewString(), "catalogVersion": version,
			"code": "return await sdk.workspace.listingRows.getState(input);", "input": map[string]string{"cardId": card, "rowId": row, "storeId": store}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(string(body)))
	req.Host = "127.0.0.1"
	req.Header.Set("Authorization", "Bearer opa_rls_"+strings.TrimPrefix(name, "ws "))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"completed"`) ||
		!strings.Contains(rec.Body.String(), `"rowId":"`+row+`"`) || !strings.Contains(rec.Body.String(), `"productId":42`) {
		t.Fatalf("MCP HTTP readback %d %s", rec.Code, rec.Body.String())
	}
	if _, err := repo.ListingState(ctx, other, begin(other), card, row, store); hostCode(err) != "domain_error" {
		t.Fatalf("other workspace: %v", err)
	}
	if _, err := repo.ListingState(ctx, first, claim, card, row, uuid.NewString()); hostCode(err) != "domain_error" {
		t.Fatalf("wrong store: %v", err)
	}
	var membership int64
	if err := pool.QueryRow(ctx, `INSERT INTO organization_members(org_id,user_id,role,status,display_name,join_order,created_at,updated_at)
		VALUES($1,$2,'member','active','member',2,clock_timestamp(),clock_timestamp()) RETURNING id`, first.OrgID, other.UserID).Scan(&membership); err != nil {
		t.Fatal(err)
	}
	memberGrantID, memberToken := uuid.NewString(), "opa_member_"+uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO automation_grants(id,user_id,org_id,name,token_hash,token_prefix,actions)
		VALUES($1::uuid,$2,$3,'member',$4,'opa_mem',ARRAY['read']::text[])`, memberGrantID, other.UserID, first.OrgID, domain.HashToken(memberToken)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM automation_executions WHERE grant_id=$1::uuid`, memberGrantID)
		_, _ = pool.Exec(ctx, `DELETE FROM automation_grants WHERE id=$1::uuid`, memberGrantID)
	})
	member, err := repo.Resolve(ctx, domain.HashToken(memberToken))
	if err != nil || member == nil {
		t.Fatalf("resolve member grant: %v", err)
	}
	memberClaim := begin(*member)
	if _, err := repo.ListingState(ctx, *member, memberClaim, card, row, store); hostCode(err) != "domain_error" {
		t.Fatalf("unassigned store: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE organization_stores SET assignee_membership_id=$1 WHERE uuid=$2::uuid`, membership, store); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ListingState(ctx, *member, memberClaim, card, row, store); err != nil {
		t.Fatalf("assigned store: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE automation_grants SET revoked_at=clock_timestamp() WHERE id=$1::uuid`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ListingState(ctx, first, claim, card, row, store); hostCode(err) != "not_authorized" {
		t.Fatalf("revoked grant: %v", err)
	}
}
