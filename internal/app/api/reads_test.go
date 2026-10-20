package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/tests/parity"
)

func TestReadErrorsMatchRustEnvelopes(t *testing.T) {
	srv := &Server{}
	h := HandlerFromMux(srv, chi.NewRouter())
	cases := []struct {
		path string
		want string
	}{
		{"/api/me/catalog/banned-tags", `{"error":"未登录","code":"AUTH_INVALID"}`},
		{"/api/admin/banned-tags", `{"error":"未登录","code":"AUTH_INVALID"}`},
		{"/api/billing/usage-stats", `{"error":"未登录","code":"AUTH_REQUIRED"}`},
		{"/api/listing/jobs", `{"error":"未登录","code":"auth_invalid"}`},
		{"/api/listing/jobs/not-a-uuid", `{"error":"未登录","code":"auth_invalid"}`},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
			Status: http.StatusUnauthorized, Body: []byte(tc.want),
		}); err != nil {
			t.Fatalf("%s: %v", tc.path, err)
		}
	}

	member := access.FixedResolver{Principal: &access.Principal{UserID: 7, OrgID: 4, WorkspaceRole: "member", PlatformRole: "admin"}}
	h = HandlerFromMux(&Server{Access: member}, chi.NewRouter())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/admin/banned-tags", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden, Body: []byte(`{"error":"需要超级管理员权限","code":"FORBIDDEN"}`),
	}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/billing/usage-stats?rollup=1", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden, Body: []byte(`{"error":"需要主管权限","code":"FORBIDDEN"}`),
	}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/listing/jobs", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusOK, Body: rec.Body.Bytes(),
	}); err == nil && rec.Code == http.StatusOK {
		t.Fatal("member without a database must not answer 200")
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("listing without db: %d %s", rec.Code, rec.Body.Bytes())
	}

	viewer := access.FixedResolver{Principal: &access.Principal{UserID: 7, OrgID: 4, WorkspaceRole: "viewer"}}
	h = HandlerFromMux(&Server{Access: viewer}, chi.NewRouter())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/listing/jobs", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden, Body: []byte(`{"error":"当前角色无权执行此操作","code":"forbidden"}`),
	}); err != nil {
		t.Fatal(err)
	}

	none := access.FixedResolver{Principal: &access.Principal{UserID: 7}}
	h = HandlerFromMux(&Server{Access: none}, chi.NewRouter())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/billing/usage-stats", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden,
		Body:   []byte(`{"error":"当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受","code":"FORBIDDEN"}`),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestUsageAndRunGoldens(t *testing.T) {
	stats, err := marshalJSON(usageStatsResponse{Data: usageStatsWire{
		Days: 30, From: "2026-07-23", To: "2026-08-21",
		Page: 1, PageSize: 25, TotalPages: 1,
		Requests:      []usageRequestWire{},
		GeneratedAtMs: 1787333400000,
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"data":{"days":30,"from":"2026-07-23","to":"2026-08-21","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":1,"page_size":25,"total_pages":1,"requests":[],"generated_at_ms":1787333400000}}`
	if err := parity.DiffHTTP(parity.Exchange{Status: 200, Body: stats}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
		t.Fatal(err)
	}

	errClass := "rate_limited"
	settled := "2026-08-21T17:30:00.000Z"
	row, err := marshalJSON(usageRequestWire{
		RequestID: "req_1", Model: "m", Operation: "ocr", Status: "settled",
		InputTokens: 3, OutputTokens: 1, CachedInputTokens: 2, ReasoningOutputTokens: 0,
		CacheHitRateBps: 6667, TotalMicrofen: 9, ChargedMicrofen: 4, AbsorbedMicrofen: 5,
		ErrorClass: &errClass, CreatedAt: "2026-08-21T17:30:00.000Z", SettledAt: &settled,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantRow := `{"request_id":"req_1","model":"m","operation":"ocr","status":"settled","input_tokens":3,"output_tokens":1,"cached_input_tokens":2,"reasoning_output_tokens":0,"cache_hit_rate_bps":6667,"total_microfen":9,"charged_microfen":4,"absorbed_microfen":5,"error_class":"rate_limited","created_at":"2026-08-21T17:30:00.000Z","settled_at":"2026-08-21T17:30:00.000Z"}`
	if err := parity.DiffHTTP(parity.Exchange{Status: 200, Body: row}, parity.Exchange{Status: 200, Body: []byte(wantRow)}); err != nil {
		t.Fatal(err)
	}
	omitted, err := marshalJSON(usageRequestWire{
		RequestID: "req_1", Model: "m", Operation: "ocr", Status: "failed",
		InputTokens: 3, OutputTokens: 0, CachedInputTokens: 0,
		CreatedAt: "2026-08-21T17:30:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := parity.DiffHTTP(parity.Exchange{Status: 200, Body: omitted}, parity.Exchange{Status: 200, Body: []byte(
		`{"request_id":"req_1","model":"m","operation":"ocr","status":"failed","input_tokens":3,"output_tokens":0,"cached_input_tokens":0,"reasoning_output_tokens":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"created_at":"2026-08-21T17:30:00.000Z"}`,
	)}); err != nil {
		t.Fatal(err)
	}

	payload, err := canonicalJSON([]byte(`{"b": 1, "a": "x&y"}`))
	if err != nil {
		t.Fatal(err)
	}
	view, err := runView(jobSource{
		ID: "11111111-1111-4111-8111-111111111111", Kind: "ai.recognize",
		AggregateType: "listing_row", AggregateID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		InputRevision: 3, State: "succeeded", Attempt: 1, IdempotencyKey: "prep-1",
		Payload: payload, Updated: pgtype.Timestamptz{Time: time.UnixMilli(1787333400000).UTC(), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := marshalJSON(listingRunResponse{Data: view})
	if err != nil {
		t.Fatal(err)
	}
	wantRun := `{"data":{"id":"11111111-1111-4111-8111-111111111111","kind":"ai.recognize","aggregateType":"listing_row","aggregateId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","inputRevision":3,"state":"succeeded","attempt":1,"idempotencyKey":"prep-1","payload":{"a":"x&y","b":1},"updatedAtMs":1787333400000}}`
	if err := parity.DiffHTTP(parity.Exchange{Status: 200, Body: raw}, parity.Exchange{Status: 200, Body: []byte(wantRun)}); err != nil {
		t.Fatal(err)
	}
}

func TestQueryAlgebra(t *testing.T) {
	if days, err := parseRangeDays(nil); err != nil || days != 30 {
		t.Fatal(days, err)
	}
	if _, err := parseRangeDays(strPtr("90")); err == nil || err.Error() != "days 必须是 7 或 30" {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 21, 17, 30, 0, 0, time.UTC)
	from, to := rangeDates(7, now)
	if from != "2026-08-15" || to != "2026-08-21" {
		t.Fatalf("%s %s", from, to)
	}
	if _, _, _, err := parseExplicitRange(strPtr("2026-08-01"), nil); err == nil {
		t.Fatal("lone from")
	}
	if _, _, ok, err := parseExplicitRange(nil, nil); err != nil || ok {
		t.Fatal(ok, err)
	}
	if _, _, _, err := parseExplicitRange(strPtr("2026-01-01"), strPtr("2026-12-31")); err == nil {
		t.Fatal("span")
	}
	if _, _, ok, err := parseExplicitRange(strPtr("2026-01-01"), strPtr("2026-04-01")); err != nil || !ok {
		t.Fatal(err, ok)
	}
	if _, err := parseSummary(strPtr("yes")); err == nil {
		t.Fatal("summary")
	}
	if n, err := parsePageSize(strPtr("101")); err == nil || n != 0 {
		t.Fatal(err)
	}
	if cacheHitRateBps(0, 100) != 0 || cacheHitRateBps(25, 100) != 2500 || cacheHitRateBps(2, 3) != 6667 || cacheHitRateBps(200, 100) != 10000 {
		t.Fatal("rate")
	}
	if totalPages(0, 25) != 1 || totalPages(26, 25) != 2 {
		t.Fatal("pages")
	}
	page, fetch := runPageBounds(100)
	if page != 100 || fetch != 100 {
		t.Fatalf("full page cursor suppressed: %d %d", page, fetch)
	}
	page, fetch = runPageBounds(50)
	if page != 50 || fetch != 51 {
		t.Fatal(page, fetch)
	}
	if micros, id := parseCursor(strPtr("nope")); micros != 0 || id != "" {
		t.Fatal("bad cursor")
	}
	if micros, id := parseCursor(strPtr("1787333400000000:11111111-1111-4111-8111-111111111111")); micros != 1787333400000000 || id != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("%d %s", micros, id)
	}
	if _, err := parseLimit(strPtr("abc")); err == nil {
		t.Fatal("limit")
	}
	org, member := aggregateUsage([]sqlc.ListBillingUsageRow{
		{UserID: 7, Metric: "ai.output_tokens", Unit: "token", Verification: "reported", Total: 3},
		{UserID: 8, Metric: "ai.input_tokens", Unit: "token", Verification: "reported", Total: 5},
		{UserID: 7, Metric: "ai.input_tokens", Unit: "token", Verification: "reported", Total: 10},
	}, 7)
	raw, err := marshalJSON(usageStatsWire{Days: 30, From: "2026-08-01", To: "2026-08-31", Organization: org, Member: member})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"days":30,"from":"2026-08-01","to":"2026-08-31","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":0,"page_size":0,"total_pages":0,"requests":null,"organization":[{"metric":"ai.input_tokens","unit":"token","verification":"reported","total":15},{"metric":"ai.output_tokens","unit":"token","verification":"reported","total":3}],"member":[{"metric":"ai.input_tokens","unit":"token","verification":"reported","total":10},{"metric":"ai.output_tokens","unit":"token","verification":"reported","total":3}],"generated_at_ms":0}`
	if err := parity.DiffHTTP(parity.Exchange{Status: 200, Body: raw}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
		t.Fatal(err)
	}
}

func strPtr(s string) *string { return &s }
