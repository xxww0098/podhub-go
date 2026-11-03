package readhttp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	readrepo "github.com/xxww0098/podhub-go/internal/listing/read/repo"
)

func TestTaskRecordsReadExistingFactsUnderTenantAndStorePermissions(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	org, owner, row := seedOwner(t, ctx, pool, "tasks-"+uuid.NewString())
	otherOrg, _, otherRow := seedOwner(t, ctx, pool, "other-tasks-"+uuid.NewString())
	member := insertUser(t, ctx, pool, "tasks-member-"+uuid.NewString())
	insertMember(t, ctx, pool, org, member, "member", 2)
	var memberID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_members WHERE org_id=$1 AND user_id=$2`, org, member).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	stores := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for i, store := range stores {
		storeOrg := org
		var assignee any
		if i == 0 {
			assignee = memberID
		} else if i == 2 {
			storeOrg = otherOrg
		}
		if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name,assignee_membership_id) VALUES($1,$2::uuid,$3,$4,$5)`, storeOrg, store, i+1, fmt.Sprintf("店铺%d", i), assignee); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET store_id=$1::uuid WHERE id=$2::uuid`, stores[0], row); err != nil {
		t.Fatal(err)
	}
	for i, state := range []string{"accepted", "unknown", "rejected"} {
		id := uuid.NewString()
		store, orgID, rowID := stores[i], org, row
		if i == 2 {
			orgID, rowID = otherOrg, otherRow
		}
		if _, err := pool.Exec(ctx, `INSERT INTO submission_intents(id,org_id,store_id,listing_row_id,row_revision,client_operation_id,request_hash,state,offer_id,external_task_id,created_at) VALUES($1::uuid,$2,$3::uuid,$4::uuid,1,$1,'hash',$5,$1,CASE WHEN $5='accepted' THEN '42' END,'2026-10-31 02:00:00+00')`, id, orgID, store, rowID, state); err != nil {
			t.Fatal(err)
		}
	}
	insertJob(t, ctx, pool, jobRow{id: uuid.NewString(), org: org, user: owner, row: row, kind: "media.render", lane: "media.render", state: "succeeded", payload: `{"api_key":"must-not-leak","executor":"browser"}`})
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'task-records-test'`); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_api", "task-records-test"
	login, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer login.Close()
	call := func(userID int64, role, query string, status int) domain.TaskRecordsPage {
		t.Helper()
		h := Host{Pool: login, ReadTaskRecords: readrepo.TaskRecords, Access: access.FixedResolver{Principal: &access.Principal{UserID: userID, OrgID: org, WorkspaceRole: role}}}
		router := chi.NewRouter()
		Mount(router, h)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/listing/task-records"+query, nil).WithContext(ctx))
		if rec.Code != status || strings.Contains(rec.Body.String(), "must-not-leak") {
			t.Fatalf("%s: %d %s", query, rec.Code, rec.Body.String())
		}
		var wire struct {
			Data domain.TaskRecordsPage `json:"data"`
		}
		if status == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
				t.Fatal(err)
			}
		}
		return wire.Data
	}
	all := call(owner, "owner", "", http.StatusOK)
	if len(all.Items) != 3 {
		t.Fatalf("owner items: %+v", all)
	}
	memberPage := call(member, "member", "", http.StatusOK)
	if len(memberPage.Items) != 2 {
		t.Fatalf("member sees unassigned store, or lost assigned media: %+v", memberPage)
	}
	call(member, "member", "?storeId="+stores[1], http.StatusNotFound)
	call(owner, "owner", "?storeId="+stores[2], http.StatusNotFound)
	attention := call(owner, "owner", "?status=attention", http.StatusOK)
	if len(attention.Items) != 1 || attention.Items[0].State != "unknown" {
		t.Fatalf("attention: %+v", attention)
	}
	first := call(owner, "owner", "?limit=1", http.StatusOK)
	if first.NextCursor == nil {
		t.Fatal("missing next page")
	}
	second := call(owner, "owner", "?limit=1&cursor="+url.QueryEscape(*first.NextCursor), http.StatusOK)
	if len(second.Items) != 1 || first.Items[0].ID == second.Items[0].ID {
		t.Fatalf("pagination repeated receipt: %+v %+v", first, second)
	}
	if _, err := pool.Exec(ctx, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, memberID); err != nil {
		t.Fatal(err)
	}
	call(member, "member", "", http.StatusForbidden)
}
