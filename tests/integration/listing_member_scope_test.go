package integration

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// TestListingMemberStoreScope pins the member boundary: a workspace member
// sees and drives only the stores assigned to their membership, plus drafts
// that have no store yet. Owners and managers see every store.
func TestListingMemberStoreScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	engine := tagsEngine(t)

	owner, org := insertWorkspace(t, ctx, pool, "scope-owner-"+uuid.NewString()+"@example.com", "Scope")
	member, _ := insertWorkspace(t, ctx, pool, "scope-member-"+uuid.NewString()+"@example.com", "Member home")
	membership := insertMember(t, ctx, pool, org, member, "member", 2)
	const (
		storeA  = "a1111111-1111-4111-8111-111111111111"
		storeB  = "a2222222-2222-4222-8222-222222222222"
		cardA   = "c1111111-1111-4111-8111-111111111111"
		cardB   = "c2222222-2222-4222-8222-222222222222"
		cardNew = "c3333333-3333-4333-8333-333333333333"
		rowA    = "b1111111-1111-4111-8111-111111111111"
		rowB    = "b2222222-2222-4222-8222-222222222222"
		rowNew  = "b3333333-3333-4333-8333-333333333333"
		jobA    = "f1111111-1111-4111-8111-111111111111"
		jobB    = "f2222222-2222-4222-8222-222222222222"
		jobOwn  = "f3333333-3333-4333-8333-333333333333"
	)
	insertStoreN(t, ctx, pool, org, storeA, 1)
	insertStoreN(t, ctx, pool, org, storeB, 2)
	if _, err := pool.Exec(ctx, `
		UPDATE organization_stores SET assignee_membership_id = $1
		 WHERE org_id = $2 AND uuid = $3::uuid`, membership, org, storeA); err != nil {
		t.Fatal(err)
	}
	insertCard(t, ctx, pool, cardA, org, "A", "2026-08-21 17:30:00+00", `{}`)
	insertCard(t, ctx, pool, cardB, org, "B", "2026-08-21 17:29:00+00", `{}`)
	insertCard(t, ctx, pool, cardNew, org, "new", "2026-08-21 17:28:00+00", `{}`)
	for card, store := range map[string]string{cardA: storeA, cardB: storeB} {
		if _, err := pool.Exec(ctx, `UPDATE listing_cards SET store_id = $1::uuid WHERE id = $2::uuid`, store, card); err != nil {
			t.Fatal(err)
		}
	}
	insertListingRow(t, ctx, pool, rowA, org, cardA)
	insertListingRow(t, ctx, pool, rowB, org, cardB)
	insertListingRow(t, ctx, pool, rowNew, org, cardNew)
	insertBrowserJob(t, ctx, pool, jobA, org, owner, rowA, "queued")
	insertBrowserJob(t, ctx, pool, jobB, org, owner, rowB, "queued")
	insertBrowserJob(t, ctx, pool, jobOwn, org, member, rowB, "queued")

	clock := func() time.Time { return time.UnixMilli(1787333400000).UTC() }
	memberH := surfaceHandler(pool, engine, access.Principal{UserID: member, OrgID: org, WorkspaceRole: "member", PlatformRole: "user"}, clock)
	ownerH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}, clock)

	cards := callJSON(memberH, http.MethodGet, "/api/listing/cards?limit=100", "")
	if cards.Code != http.StatusOK || !strings.Contains(cards.Body.String(), cardA) || !strings.Contains(cards.Body.String(), cardNew) || strings.Contains(cards.Body.String(), cardB) {
		t.Fatalf("member cards %d %s", cards.Code, cards.Body.String())
	}
	for _, path := range []string{
		"/api/listing/cards/" + cardB,
		"/api/listing/cards/" + cardB + "/snapshot",
	} {
		if rec := callJSON(memberH, http.MethodGet, path, ""); rec.Code != http.StatusNotFound {
			t.Fatalf("hidden card %s %d %s", path, rec.Code, rec.Body.String())
		}
	}
	if rec := callJSON(memberH, http.MethodPost, "/api/listing/cards/"+cardB+"/copy", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("hidden card copy %d %s", rec.Code, rec.Body.String())
	}
	if rec := callJSON(memberH, http.MethodGet, "/api/listing/cards/"+cardA, ""); rec.Code != http.StatusOK {
		t.Fatalf("assigned card %d %s", rec.Code, rec.Body.String())
	}

	rows := callJSON(memberH, http.MethodGet, "/api/listing/rows?limit=100", "")
	if rows.Code != http.StatusOK || !strings.Contains(rows.Body.String(), rowA) || !strings.Contains(rows.Body.String(), rowNew) || strings.Contains(rows.Body.String(), rowB) {
		t.Fatalf("member rows %d %s", rows.Code, rows.Body.String())
	}
	if rec := callJSON(memberH, http.MethodGet, "/api/listing/rows/"+rowB, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("hidden row read %d %s", rec.Code, rec.Body.String())
	}
	if rec := callJSON(memberH, http.MethodPatch, "/api/listing/rows/"+rowB, `{"baseRevision":1}`); rec.Code != http.StatusNotFound {
		t.Fatalf("hidden row patch %d %s", rec.Code, rec.Body.String())
	}
	if rec := callJSON(memberH, http.MethodDelete, "/api/listing/rows/"+rowB, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("hidden row delete %d %s", rec.Code, rec.Body.String())
	}

	jobs := callJSON(memberH, http.MethodGet, "/api/listing/jobs?limit=100", "")
	if jobs.Code != http.StatusOK || !strings.Contains(jobs.Body.String(), jobA) || !strings.Contains(jobs.Body.String(), jobOwn) || strings.Contains(jobs.Body.String(), jobB) {
		t.Fatalf("member jobs %d %s", jobs.Code, jobs.Body.String())
	}
	if rec := callJSON(memberH, http.MethodGet, "/api/listing/jobs/"+jobB, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("hidden job read %d %s", rec.Code, rec.Body.String())
	}
	if rec := callJSON(memberH, http.MethodPost, "/api/listing/jobs/"+jobB+"/claim", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("hidden job claim %d %s", rec.Code, rec.Body.String())
	}

	allCards := callJSON(ownerH, http.MethodGet, "/api/listing/cards?limit=100", "")
	if allCards.Code != http.StatusOK || !strings.Contains(allCards.Body.String(), cardA) || !strings.Contains(allCards.Body.String(), cardB) || !strings.Contains(allCards.Body.String(), cardNew) {
		t.Fatalf("owner cards %d %s", allCards.Code, allCards.Body.String())
	}
	allRows := callJSON(ownerH, http.MethodGet, "/api/listing/rows?limit=100", "")
	if allRows.Code != http.StatusOK || !strings.Contains(allRows.Body.String(), rowB) {
		t.Fatalf("owner rows %d %s", allRows.Code, allRows.Body.String())
	}
	allJobs := callJSON(ownerH, http.MethodGet, "/api/listing/jobs?limit=100", "")
	if allJobs.Code != http.StatusOK || !strings.Contains(allJobs.Body.String(), jobA) || !strings.Contains(allJobs.Body.String(), jobB) || !strings.Contains(allJobs.Body.String(), jobOwn) {
		t.Fatalf("owner jobs %d %s", allJobs.Code, allJobs.Body.String())
	}
}
