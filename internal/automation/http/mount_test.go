package automationhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/automation/domain"
	"github.com/xxww0098/podhub-go/internal/automation/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestAutomationRoutes(t *testing.T) {
	if len(Routes()) != 13 {
		t.Fatalf("%d", len(Routes()))
	}
	r := chi.NewRouter()
	Mount(r, Deps{})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/automation/commands/claim", strings.NewReader(`{}`)))
	if rec.Code != http.StatusUnauthorized || rec.Body.String() != `{"error":"未登录","code":"AUTH_INVALID"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(rec.Header())
	}

	owner := &access.Principal{UserID: 2, OrgID: 5, WorkspaceRole: "owner"}
	r = chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(owner), Actions: service.New(scriptStore{}, fixedNow, bytes.NewReader(make([]byte, 32)))})
	for _, rt := range Routes() {
		rec = httptest.NewRecorder()
		path := strings.ReplaceAll(rt.Path, "{id}", "not-a-uuid")
		req := httptest.NewRequest(rt.Method, path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(rec, req)
		if rec.Code == http.StatusNotImplemented || strings.Contains(rec.Body.String(), "not_ported") {
			t.Fatalf("%s %s still unported %d %s", rt.Method, rt.Path, rec.Code, rec.Body.String())
		}
	}
}

func TestAuthAndValidationBytes(t *testing.T) {
	store := scriptStore{}
	h := func(role string, org int64) http.Handler {
		r := chi.NewRouter()
		Mount(r, Deps{Resolve: fixed(&access.Principal{UserID: 2, OrgID: org, WorkspaceRole: role}), Actions: service.New(store, fixedNow, bytes.NewReader(bytes.Repeat([]byte{0}, 64)))})
		return r
	}
	owner := h("owner", 5)
	cases := []struct {
		name, method, path, body, role string
		org                            int64
		status                         int
		want                           string
	}{
		{name: "no workspace", method: "GET", path: "/api/automation/grants", org: 0, status: 403, want: `{"error":"当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受","code":"FORBIDDEN"}`},
		{name: "blank role", method: "GET", path: "/api/automation/grants", role: "  ", org: 5, status: 403, want: `{"error":"当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受","code":"FORBIDDEN"}`},
		{name: "bad role", method: "GET", path: "/api/automation/grants", role: "root", org: 5, status: 403, want: `{"error":"工作空间角色无效","code":"FORBIDDEN"}`},
		{name: "asset name", method: "POST", path: "/api/automation/asset-sets", body: `{"name":"  ","items":[]}`, status: 400, want: `{"error":"名称不能为空且不超过 120 字符","code":"VALIDATION"}`},
		{name: "too many", method: "POST", path: "/api/automation/asset-sets", body: `{"name":"n","items":` + items(501) + `}`, status: 400, want: `{"error":"素材集合最多 500 项","code":"VALIDATION"}`},
		{name: "bad item", method: "POST", path: "/api/automation/asset-sets", body: `{"name":"n","items":[{"fileName":"a","sha256":"zz"}]}`, status: 400, want: `{"error":"素材项需要文件名与 64 位十六进制 SHA-256","code":"VALIDATION"}`},
		{name: "unknown field", method: "POST", path: "/api/automation/asset-sets", body: `{"name":"n","items":[],"extra":1}`, status: 400, want: `{"error":"请求格式无效","code":"VALIDATION"}`},
		{name: "missing content type", method: "POST", path: "/api/automation/asset-sets", body: `{"name":"n","items":[]}`, status: 400, want: `{"error":"请求格式无效","code":"VALIDATION"}`},
		{name: "claim uuid", method: "POST", path: "/api/automation/commands/claim", body: `{"runtimeId":"nope"}`, status: 404, want: `{"error":"执行端不存在","code":"NOT_FOUND"}`},
		{name: "renew claim", method: "POST", path: "/api/automation/commands/renew", body: `{"runtimeId":"11111111-1111-4111-8111-111111111111","claims":[{"operationId":"nope","claimEpoch":1}]}`, status: 400, want: `{"error":"claim 格式无效","code":"VALIDATION"}`},
		{name: "renew epoch", method: "POST", path: "/api/automation/commands/renew", body: `{"runtimeId":"11111111-1111-4111-8111-111111111111","claims":[{"operationId":"11111111-1111-4111-8111-111111111111","claimEpoch":-1}]}`, status: 400, want: `{"error":"claim 格式无效","code":"VALIDATION"}`},
		{name: "settle status before id", method: "POST", path: "/api/automation/commands/not-a-uuid/settle", body: `{"claimEpoch":1,"status":"cancelled"}`, status: 400, want: `{"error":"status 须为 completed|failed|canceled","code":"VALIDATION"}`},
		{name: "settle id", method: "POST", path: "/api/automation/commands/not-a-uuid/settle", body: `{"claimEpoch":1,"status":"completed"}`, status: 404, want: `{"error":"操作不存在","code":"NOT_FOUND"}`},
		{name: "progress id", method: "POST", path: "/api/automation/commands/not-a-uuid/progress", body: `{"claimEpoch":1,"progress":{}}`, status: 404, want: `{"error":"操作不存在","code":"NOT_FOUND"}`},
		{name: "unknown action raw", method: "POST", path: "/api/automation/grants", body: `{"name":"bad","actions":["  x  "]}`, status: 400, want: `{"error":"未知的授权动作   x  ","code":"VALIDATION"}`},
		{name: "viewer prepare", method: "POST", path: "/api/automation/grants", role: "viewer", body: `{"name":"bad","actions":["prepare"]}`, status: 400, want: `{"error":"当前角色无权委托 prepare","code":"VALIDATION"}`},
		{name: "empty actions", method: "POST", path: "/api/automation/grants", body: `{"name":"bad","actions":[]}`, status: 400, want: `{"error":"至少选择一个授权动作","code":"VALIDATION"}`},
		{name: "expiry", method: "POST", path: "/api/automation/grants", body: `{"name":"bad","actions":["read"],"expiresInDays":0}`, status: 400, want: `{"error":"有效期须在 1 到 3650 天之间","code":"VALIDATION"}`},
		{name: "renderer", method: "POST", path: "/api/automation/runtimes", body: `{"grantId":"11111111-1111-4111-8111-111111111111","label":"tab","rendererContract":""}`, status: 400, want: `{"error":"渲染契约版本无效","code":"VALIDATION"}`},
		{name: "grant uuid", method: "POST", path: "/api/automation/runtimes", body: `{"grantId":"nope","label":"tab","rendererContract":"psd-x@1"}`, status: 404, want: `{"error":"授权不存在","code":"NOT_FOUND"}`},
		{name: "revoke uuid", method: "POST", path: "/api/automation/grants/not-a-uuid/revoke", status: 404, want: `{"error":"授权不存在","code":"NOT_FOUND"}`},
		{name: "heartbeat uuid", method: "POST", path: "/api/automation/runtimes/not-a-uuid/heartbeat", status: 404, want: `{"error":"执行端不存在","code":"NOT_FOUND"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			role := tc.role
			if role == "" {
				role = "owner"
			}
			org := tc.org
			if org == 0 && tc.name != "no workspace" {
				org = 5
			}
			handler := owner
			if role != "owner" || org != 5 {
				handler = h(role, org)
			}
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.name != "missing content type" && tc.method == http.MethodPost && tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			if tc.method == http.MethodPost && tc.body == "" {
				req.Body = io.NopCloser(strings.NewReader(""))
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.status || rec.Body.String() != tc.want {
				t.Fatalf("%d %s\nwant %d %s", rec.Code, rec.Body.String(), tc.status, tc.want)
			}
		})
	}
}

func TestSuccessBytes(t *testing.T) {
	sha := strings.Repeat("a", 64)
	store := scriptStore{
		sets: []domain.AssetSet{{
			ID: "set-1", Name: "demo", CreatedAtMS: 0,
			Items: []domain.AssetItem{{ID: "item-1", FileName: "a.jpg", SHA256: sha, SizeBytes: 3}},
		}},
		claimed: []domain.Claimed{{
			OperationID: "op-1", Action: "listing_prepare", ClientRequestID: "req-1",
			ClaimEpoch: 1, Payload: json.RawMessage(`{"rowIds":[1]}`),
		}},
		hits:   []domain.RenewHit{{Matched: true}, {}},
		grants: []domain.GrantView{{ID: "g-1", Name: "ci agent", Actions: []string{"read"}, TokenPrefix: "opa_AAAAAAAA", CreatedAtMS: 0}},
		runtimes: []domain.RuntimeRow{{
			ID: "rt-1", GrantID: "g-1", Label: "ci tab", RendererContract: "psd-x@1",
			HeartbeatAtMS: fixedNow().UnixMilli(), CreatedAtMS: 0,
		}},
		write: domain.WriteResult{Applied: true},
	}
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(&access.Principal{UserID: 2, OrgID: 5, WorkspaceRole: "owner"}), Actions: service.New(store, fixedNow, bytes.NewReader(make([]byte, 32)))})
	calls := []struct {
		method, path, body, want string
	}{
		{"GET", "/api/automation/asset-sets", "", `{"data":{"sets":[{"id":"set-1","name":"demo","createdAtMs":0,"items":[{"id":"item-1","fileName":"a.jpg","sha256":"` + sha + `","sizeBytes":3}]}]}}`},
		{"POST", "/api/automation/asset-sets", `{"name":"demo","items":[]}`, `{"data":{"set":{"id":"set-1","name":"demo","createdAtMs":0,"items":[{"id":"item-1","fileName":"a.jpg","sha256":"` + sha + `","sizeBytes":3}]}}}`},
		{"POST", "/api/automation/commands/claim", `{"runtimeId":"11111111-1111-4111-8111-111111111111"}`, `{"data":{"commands":[{"operationId":"op-1","action":"listing_prepare","clientRequestId":"req-1","claimEpoch":1,"payload":{"rowIds":[1]},"cancelRequested":false}],"lease_seconds":90}}`},
		{"POST", "/api/automation/commands/renew", `{"runtimeId":"11111111-1111-4111-8111-111111111111","claims":[{"operationId":"22222222-2222-4222-8222-222222222222","claimEpoch":1},{"operationId":"33333333-3333-4333-8333-333333333333","claimEpoch":0}]}`, `{"data":{"leases":[{"operationId":"22222222-2222-4222-8222-222222222222","control":"continue","leaseSeconds":90},{"operationId":"33333333-3333-4333-8333-333333333333","control":"lost","leaseSeconds":0}]}}`},
		{"POST", "/api/automation/commands/22222222-2222-4222-8222-222222222222/progress", `{"claimEpoch":1,"progress":{"done":1}}`, `{"data":{"accepted":true,"cancelRequested":false}}`},
		{"POST", "/api/automation/commands/22222222-2222-4222-8222-222222222222/settle", `{"claimEpoch":1,"status":"completed"}`, `{"data":{"accepted":true,"cancelRequested":false}}`},
		{"GET", "/api/automation/grants", "", `{"data":{"grants":[{"id":"g-1","name":"ci agent","actions":["read"],"tokenPrefix":"opa_AAAAAAAA","createdAtMs":0}]}}`},
		{"POST", "/api/automation/grants", `{"name":"ci agent","actions":["read"]}`, `{"data":{"grant":{"id":"g-1","name":"ci agent","actions":["read"],"tokenPrefix":"opa_AAAAAAAA","createdAtMs":0},"token":"opa_` + strings.Repeat("A", 43) + `"}}`},
		{"POST", "/api/automation/grants/44444444-4444-4444-8444-444444444444/revoke", ``, `{"data":{"id":"44444444-4444-4444-8444-444444444444","revoked":true}}`},
		{"GET", "/api/automation/runtimes", "", `{"data":{"runtimes":[{"id":"rt-1","grantId":"g-1","label":"ci tab","rendererContract":"psd-x@1","heartbeatAtMs":` + ms + `,"live":true,"createdAtMs":0}]}}`},
		{"POST", "/api/automation/runtimes", `{"grantId":"44444444-4444-4444-8444-444444444444","label":"ci tab","rendererContract":"psd-x@1"}`, `{"data":{"runtime":{"id":"rt-1","grantId":"g-1","label":"ci tab","rendererContract":"psd-x@1","heartbeatAtMs":` + ms + `,"live":true,"createdAtMs":0},"claim_lease_seconds":90}}`},
		{"POST", "/api/automation/runtimes/11111111-1111-4111-8111-111111111111/heartbeat", `{}`, `{"data":{"runtime":{"id":"rt-1","grantId":"g-1","label":"ci tab","rendererContract":"psd-x@1","heartbeatAtMs":` + ms + `,"live":true,"createdAtMs":0}}}`},
		{"POST", "/api/automation/runtimes/11111111-1111-4111-8111-111111111111/deregister", `{}`, `{"data":{"runtime":{"id":"rt-1","grantId":"g-1","label":"ci tab","rendererContract":"psd-x@1","heartbeatAtMs":` + ms + `,"live":true,"createdAtMs":0}}}`},
	}
	for _, tc := range calls {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.method == http.MethodPost {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Body.String() != tc.want {
			t.Fatalf("%s %s\n got %d %s\nwant %d %s", tc.method, tc.path, rec.Code, rec.Body.String(), http.StatusOK, tc.want)
		}
	}
}

func TestStaleWriteAndEmptyClaim(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{
		Resolve: fixed(&access.Principal{UserID: 2, OrgID: 5, WorkspaceRole: "member"}),
		Actions: service.New(scriptStore{}, fixedNow, bytes.NewReader(make([]byte, 32))),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/automation/commands/claim", strings.NewReader(`{"runtimeId":"11111111-1111-4111-8111-111111111111","limit":null}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Body.String() != `{"data":{"commands":[],"lease_seconds":90}}` {
		t.Fatal(rec.Body.String())
	}
	r = chi.NewRouter()
	Mount(r, Deps{
		Resolve: fixed(&access.Principal{UserID: 2, OrgID: 5, WorkspaceRole: "owner"}),
		Actions: service.New(scriptStore{write: domain.WriteResult{}}, fixedNow, bytes.NewReader(make([]byte, 32))),
	})
	req = httptest.NewRequest(http.MethodPost, "/api/automation/commands/22222222-2222-4222-8222-222222222222/settle", strings.NewReader(`{"claimEpoch":1,"status":"failed","error":{"code":"command_dispatch_failed","message":"x"}}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Body.String() != `{"data":{"accepted":false,"cancelRequested":true}}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestAutomationDoesNotDial(t *testing.T) {
	var hits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Error(w, "no", http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	r := chi.NewRouter()
	Mount(r, Deps{
		Resolve: fixed(&access.Principal{UserID: 2, OrgID: 5, WorkspaceRole: "owner"}),
		Actions: service.New(scriptStore{}, fixedNow, bytes.NewReader(make([]byte, 64))),
	})
	for _, rt := range Routes() {
		path := strings.ReplaceAll(rt.Path, "{id}", "11111111-1111-4111-8111-111111111111")
		body := "{}"
		switch rt.Path {
		case "/api/automation/asset-sets":
			if rt.Method == http.MethodPost {
				body = `{"name":"n","items":[]}`
			}
		case "/api/automation/commands/claim":
			body = `{"runtimeId":"11111111-1111-4111-8111-111111111111"}`
		case "/api/automation/commands/renew":
			body = `{"runtimeId":"11111111-1111-4111-8111-111111111111","claims":[]}`
		case "/api/automation/commands/{id}/progress":
			body = `{"claimEpoch":1,"progress":{}}`
		case "/api/automation/commands/{id}/settle":
			body = `{"claimEpoch":1,"status":"completed"}`
		case "/api/automation/grants":
			if rt.Method == http.MethodPost {
				body = `{"name":"n","actions":["read"]}`
			}
		case "/api/automation/runtimes":
			if rt.Method == http.MethodPost {
				body = `{"grantId":"11111111-1111-4111-8111-111111111111","label":"t","rendererContract":"v"}`
			}
		}
		req := httptest.NewRequest(rt.Method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Upstream", upstream.URL)
		r.ServeHTTP(httptest.NewRecorder(), req)
	}
	if hits != 0 {
		t.Fatalf("outbound %d", hits)
	}
}

func items(n int) string {
	parts := make([]string, n)
	sha := strings.Repeat("a", 64)
	for i := range parts {
		parts[i] = `{"fileName":"a","sha256":"` + sha + `"}`
	}
	return "[" + strings.Join(parts, ",") + "]"
}

var fixedNow = func() time.Time { return time.UnixMilli(1_700_000_000_000) }

const ms = "1700000000000"

type scriptStore struct {
	sets     []domain.AssetSet
	claimed  []domain.Claimed
	hits     []domain.RenewHit
	write    domain.WriteResult
	grants   []domain.GrantView
	runtimes []domain.RuntimeRow
}

func (s scriptStore) ListAssetSets(context.Context, int64, int64) ([]domain.AssetSet, error) {
	return s.sets, nil
}
func (s scriptStore) CreateAssetSet(context.Context, int64, int64, string, []domain.ItemInput) (domain.AssetSet, error) {
	if len(s.sets) == 0 {
		return domain.AssetSet{Items: []domain.AssetItem{}}, nil
	}
	return s.sets[0], nil
}
func (s scriptStore) Claim(context.Context, int64, int64, string, int64) ([]domain.Claimed, error) {
	return s.claimed, nil
}
func (s scriptStore) Renew(context.Context, int64, int64, string, []string, []int64) ([]domain.RenewHit, error) {
	if s.hits != nil {
		return s.hits, nil
	}
	return []domain.RenewHit{}, nil
}
func (s scriptStore) Progress(context.Context, int64, int64, string, int64, json.RawMessage) (domain.WriteResult, error) {
	return s.write, nil
}
func (s scriptStore) Settle(context.Context, int64, int64, string, int64, string, *json.RawMessage, *json.RawMessage) (domain.WriteResult, error) {
	return s.write, nil
}
func (s scriptStore) ListGrants(context.Context, int64, int64) ([]domain.GrantView, error) {
	return s.grants, nil
}
func (s scriptStore) CreateGrant(context.Context, int64, int64, string, string, string, []string, *int64) (domain.GrantView, error) {
	if len(s.grants) == 0 {
		return domain.GrantView{Actions: []string{"read"}}, nil
	}
	return s.grants[0], nil
}
func (s scriptStore) RevokeGrant(_ context.Context, _, _ int64, id string) (string, error) {
	return id, nil
}
func (s scriptStore) ListRuntimes(context.Context, int64, int64) ([]domain.RuntimeRow, error) {
	return s.runtimes, nil
}
func (s scriptStore) RegisterRuntime(context.Context, int64, int64, string, string, string) (domain.RuntimeRow, error) {
	if len(s.runtimes) == 0 {
		return domain.RuntimeRow{}, nil
	}
	return s.runtimes[0], nil
}
func (s scriptStore) DeregisterRuntime(context.Context, int64, int64, string) (domain.RuntimeRow, error) {
	if len(s.runtimes) == 0 {
		return domain.RuntimeRow{}, nil
	}
	return s.runtimes[0], nil
}
func (s scriptStore) HeartbeatRuntime(context.Context, int64, int64, string) (domain.RuntimeRow, error) {
	if len(s.runtimes) == 0 {
		return domain.RuntimeRow{}, nil
	}
	return s.runtimes[0], nil
}

func fixed(p *access.Principal) Resolve {
	return func(*http.Request) (*Session, *Refusal, error) {
		return &Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole}, nil, nil
	}
}
