package mcphttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	"github.com/xxww0098/podhub-go/internal/mcp/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestMCPGateOrder(t *testing.T) {
	t.Setenv("CLOUD_MCP_ALLOWED_HOSTS", "mcp.example")
	t.Setenv("CLOUD_MCP_ALLOWED_ORIGINS", "https://app.example")
	cfg := config.Load().MCPSettings()
	r := chi.NewRouter()
	deps := Deps{
		Allow:      domain.Allow{Hosts: cfg.AllowedHosts, Origins: cfg.AllowedOrigins},
		RunnerPath: cfg.RunnerPath,
		Handler:    service.New(fakeStore{grant: sampleGrant()}),
	}
	Mount(r, deps)
	if deps.Runner() != "podhub-mcp-runner" {
		t.Fatal(deps.Runner())
	}

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
	req.Host = "evil.example"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || rec.Body.String() != `{"error":"invalid or expired automation grant token"}` {
		t.Fatalf("unauth host %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("WWW-Authenticate") != `Bearer realm="mcp"` {
		t.Fatal(rec.Header().Get("WWW-Authenticate"))
	}

	req = httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Host = "evil.example"
	req.Header.Set("Authorization", "Bearer opa_secret")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed || rec.Body.String() != "Method Not Allowed" || rec.Header().Get("Allow") != "POST" {
		t.Fatalf("method %d %q allow %q", rec.Code, rec.Body.String(), rec.Header().Get("Allow"))
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	req.Host = "evil.example"
	req.Header.Set("Authorization", "Bearer opa_secret")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || rec.Body.String() != "Forbidden: Host header is not allowed" {
		t.Fatalf("host %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	req.Host = "mcp.example"
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Authorization", "Bearer opa_secret")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || rec.Body.String() != "Forbidden: Origin header is not allowed" {
		t.Fatalf("origin %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	req.Host = "mcp.example"
	req.Header.Set("Origin", "https://app.example")
	req.Header.Set("Authorization", "Bearer nope")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bearer %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
	req.Host = "mcp.example"
	req.Header.Set("Origin", "https://app.example")
	req.Header.Set("Authorization", "Bearer opa_secret")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"search"`) || !strings.Contains(rec.Body.String(), `"execute"`) {
		t.Fatalf("tools %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "opa_secret") {
		t.Fatal("token leaked")
	}
}

func TestMCPSearchAndCatalogChanged(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Handler: service.New(fakeStore{grant: sampleGrant()})})
	version := catalogVersion(t)
	body := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"names":["workspace.getContext"]}}}`
	rec := call(r, body)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"catalogVersion":"`+version+`"`) {
		t.Fatalf("search %d %s", rec.Code, rec.Body.String())
	}
	exec := `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"execute","arguments":{"executionId":"4c6e26ec-9e8f-46e1-bc45-0289951d5f16","catalogVersion":"stale","code":"return await sdk.workspace.getContext(input);","input":{}}}}`
	rec = call(r, exec)
	if !strings.Contains(rec.Body.String(), `"code":"catalog_changed"`) || !strings.Contains(rec.Body.String(), `"isError":true`) {
		t.Fatalf("changed %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Search the current authorized catalog before executing") {
		t.Fatal(rec.Body.String())
	}
}

func catalogVersion(t *testing.T) string {
	t.Helper()
	v, err := domain.Version(sampleGrant())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func call(r http.Handler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = "localhost"
	req.Header.Set("Authorization", "Bearer opa_secret")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func sampleGrant() domain.Grant {
	return domain.Grant{
		ID: "11111111-1111-4111-8111-111111111111", UserID: 7, OrgID: 3,
		ScopeKind: "workspace", Actions: []string{"read"}, WorkspaceRole: "owner", PlatformRole: "user",
	}
}

type fakeStore struct{ grant domain.Grant }

func (f fakeStore) Resolve(context.Context, string) (*domain.Grant, error) {
	g := f.grant
	return &g, nil
}
func (f fakeStore) Begin(context.Context, domain.Grant, string, string, string) (domain.Start, error) {
	return domain.Start{}, domain.NewHost("internal", "Service is temporarily unavailable")
}
func (f fakeStore) Finish(context.Context, domain.Grant, domain.Claim, string, *domain.HostError, int) (domain.Envelope, error) {
	return domain.Envelope{}, domain.NewHost("internal", "Service is temporarily unavailable")
}
func (f fakeStore) WorkspaceName(context.Context, domain.Grant, domain.Claim) (string, error) {
	return "", domain.NewHost("internal", "Service is temporarily unavailable")
}
func (f fakeStore) ExecutionView(context.Context, domain.Grant, domain.Claim, string) (domain.Envelope, error) {
	return domain.Envelope{}, domain.NewHost("internal", "Service is temporarily unavailable")
}

var _ = json.RawMessage(nil)
