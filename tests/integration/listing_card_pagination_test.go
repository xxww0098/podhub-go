package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestListingCardPagination(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org := insertWorkspace(t, ctx, pool, "pagination-a@example.com", "Pagination A")
	_, otherOrg := insertWorkspace(t, ctx, pool, "pagination-b@example.com", "Pagination B")
	id := func(n int) string { return fmt.Sprintf("%08x-1111-4111-8111-111111111111", n) }
	const updated = "2026-08-21 17:30:00.000123+00"
	for n := 1; n <= 101; n++ {
		insertCard(t, ctx, pool, id(n), org, fmt.Sprint(n), updated, `{}`)
	}
	// The final card shares the displayed millisecond but differs in cursor microseconds.
	insertCard(t, ctx, pool, id(102), org, "older", "2026-08-21 17:30:00.000122+00", `{}`)
	insertCard(t, ctx, pool, id(103), otherOrg, "hidden", updated, `{}`)
	engine := tagsEngine(t)
	handler := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "member", PlatformRole: "user"}, time.Now)

	var got []string
	cursor := ""
	for page := 0; page < 2; page++ {
		path := "/api/listing/cards?limit=100"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		rec := callJSON(handler, http.MethodGet, path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("page %d: %d %s", page, rec.Code, rec.Body.String())
		}
		var response struct {
			Data struct {
				Items []struct {
					ID          string `json:"id"`
					UpdatedAtMs int64  `json:"updated_at_ms"`
				} `json:"items"`
				NextCursor string `json:"nextCursor"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		wantSize := 100
		if page == 1 {
			wantSize = 2
		}
		if len(response.Data.Items) != wantSize {
			t.Fatalf("page %d size: got %d want %d", page, len(response.Data.Items), wantSize)
		}
		for _, card := range response.Data.Items {
			if card.UpdatedAtMs != 1787333400000 {
				t.Fatalf("persisted timestamp contract: %+v", card)
			}
			got = append(got, card.ID)
		}
		cursor = response.Data.NextCursor
		if page == 0 && cursor != "1787333400000123:"+id(2) {
			t.Fatalf("first page cursor lost precision/order: %q", cursor)
		}
		if page == 1 && cursor != "" {
			t.Fatalf("final page has cursor: %q", cursor)
		}
	}
	for offset, cardID := range got {
		want := id(101 - offset)
		if offset == 101 {
			want = id(102)
		}
		if cardID != want {
			t.Fatalf("row %d: got %s want %s (tenant leak, missing or reordered card)", offset, cardID, want)
		}
	}
}
