package identity

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestMustChangePasswordWhitelist pins doc §4.2's allow-list. The gate is
// deny-by-default, so a method+path pair that is not listed here is blocked;
// this test is the only place the five real entries are enumerated.
func TestMustChangePasswordWhitelist(t *testing.T) {
	allowed := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/logout"},
		{http.MethodGet, "/api/auth/session"},
		{http.MethodPost, "/api/auth/password"},
		{http.MethodGet, "/api/health"},
	}
	for _, want := range allowed {
		if !allowWhileLocked(want.path, want.method) {
			t.Fatalf("%s %s must be reachable while locked", want.method, want.path)
		}
	}
	if len(allowed) != 5 {
		t.Fatalf("whitelist size %d", len(allowed))
	}
	// The doc's sixth entry ("static assets / CSRF preflight") is not an HTTP
	// route: this process serves no static files, and CSRF is a separate
	// middleware mounted before this one, so it never reaches the gate. There
	// must be no path-shaped stand-in for it.
	for _, path := range []string{"/", "/static", "/static/app.js", "/assets/index.js", "/favicon.ico", "/*"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodOptions} {
			if allowWhileLocked(path, method) {
				t.Fatalf("%s %s must not be whitelisted", method, path)
			}
		}
	}
}

// TestMustChangePasswordBlocksEverythingElse walks the route families doc §4.2
// calls out by hand: admin user management (including the staff password reset,
// which is NOT the self-service entry), supplier reads and writes, listing
// reads, the account overview, SSE and the other auth verbs.
func TestMustChangePasswordBlocksEverythingElse(t *testing.T) {
	blocked := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/users"},
		{http.MethodPost, "/api/admin/users"},
		{http.MethodPost, "/api/admin/users/{uuid}/password"},
		{http.MethodPost, "/api/admin/users/u-1/password"},
		{http.MethodGet, "/api/supplier/workspaces/factory/dispatches"},
		{http.MethodGet, "/api/supplier/workspaces/factory/dashboard"},
		// The wallet and withdrawal routes are gone (F1: a supplier has no funds
		// surface at all). These two are the supplier reads and writes that still
		// exist, so the gate still has real supplier paths to block.
		{http.MethodGet, "/api/supplier/me"},
		{http.MethodPost, "/api/supplier/dispatches/{dispatch_id}/accept"},
		{http.MethodGet, "/api/listing/events"},
		{http.MethodGet, "/api/listing/cards"},
		{http.MethodGet, "/api/view/account-overview"},
		{http.MethodPost, "/api/auth/register"},
		{http.MethodPost, "/api/auth/forgot"},
		{http.MethodPost, "/api/auth/reset"},

		{http.MethodPut, "/api/auth/name"},

		{http.MethodGet, "/api/workspaces"},
		{http.MethodPost, "/api/workspaces"},
		{http.MethodGet, "/api/notifications"},
		{http.MethodGet, "/api/me"},
	}
	for _, want := range blocked {
		if allowWhileLocked(want.path, want.method) {
			t.Fatalf("%s %s must be blocked while locked", want.method, want.path)
		}
	}
	// The whitelist matches the method too: a GET on the password entry is a
	// different route and must not inherit the POST allowance.
	for _, want := range []struct{ method, path string }{
		{http.MethodGet, "/api/auth/login"},
		{http.MethodGet, "/api/auth/logout"},
		{http.MethodPost, "/api/auth/session"},
		{http.MethodPut, "/api/auth/password"},
		{http.MethodPost, "/api/health"},
		{http.MethodDelete, "/api/auth/session"},
	} {
		if allowWhileLocked(want.path, want.method) {
			t.Fatalf("%s %s must be blocked: the whitelist is method-exact", want.method, want.path)
		}
	}
	// A prefix must not leak the entry either.
	for _, path := range []string{
		"/api/auth/password/reset", "/api/auth/password/", "/api/auth/session/x",
		"/api/auth/login/x", "/api/health/deep", "/api/auth/logout/x",
	} {
		if allowWhileLocked(path, http.MethodPost) || allowWhileLocked(path, http.MethodGet) {
			t.Fatalf("%s must not match by prefix", path)
		}
	}
}

func TestRefuseWhileLockedBody(t *testing.T) {
	acc := account{id: 7, mustChangePassword: true}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/supplier/workspaces/factory/dispatches", nil)
	if !refuseWhileLocked(rec, req, acc) {
		t.Fatal("locked account must be refused")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d", rec.Code)
	}
	if got, want := rec.Body.String(), `{"code":"PASSWORD_CHANGE_REQUIRED","message":"请先修改密码"}`; got != want {
		t.Fatalf("body %s", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type %s", ct)
	}
	// An unlocked account is never refused, even outside the whitelist.
	rec = httptest.NewRecorder()
	if refuseWhileLocked(rec, req, account{id: 7}) {
		t.Fatal("unlocked account must pass")
	}
	if rec.Body.Len() != 0 || rec.Code != http.StatusOK {
		t.Fatalf("unlocked wrote %d %s", rec.Code, rec.Body.Bytes())
	}
	// Whitelisted path passes while locked.
	rec = httptest.NewRecorder()
	session := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	if refuseWhileLocked(rec, session, acc) {
		t.Fatal("whitelisted path must pass while locked")
	}
}

// TestGateSitsBehindCSRF records the ordering the doc's sixth whitelist entry
// stands for: CSRF is mounted before the gate, so a cross-origin cookie write
// is rejected as csrf_rejected and never reaches PASSWORD_CHANGE_REQUIRED. If
// this ever flips, the "static assets / CSRF preflight" line in §4.2 would
// need a real route.
func TestGateSitsBehindCSRF(t *testing.T) {
	reached := false
	gated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		if refuseWhileLocked(w, r, account{id: 7, mustChangePassword: true}) {
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	handler := CSRF(gated)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/password", nil)
	req.Header.Set("Cookie", SessionCookie+"=token")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if reached {
		t.Fatal("cross-origin write reached the gate")
	}
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"code":"csrf_rejected","message":"跨站请求已被拒绝"}` {
		t.Fatalf("csrf %d %s", rec.Code, rec.Body.String())
	}
	// Same-origin reaches the gate; the whitelisted password entry passes.
	reached = false
	req = httptest.NewRequest(http.MethodPost, "/api/auth/password", nil)
	req.Header.Set("Cookie", SessionCookie+"=token")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if !reached || rec.Code != http.StatusOK {
		t.Fatalf("same-origin %d %s", rec.Code, rec.Body.String())
	}
}

// TestMiddlewarePassThroughNeedsNoPool covers the two short-circuits that run
// before the gate and therefore must not depend on a database: /api/health and
// a request that presents no credential at all.
func TestMiddlewarePassThroughNeedsNoPool(t *testing.T) {
	svc := New(nil)
	called := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++ })
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/health", nil),
		httptest.NewRequest(http.MethodGet, "/api/auth/session", nil),
	} {
		rec := httptest.NewRecorder()
		svc.Middleware(next).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %d", req.URL.Path, rec.Code)
		}
	}
	if called != 2 {
		t.Fatalf("next called %d times", called)
	}
}

// TestSessionWireCarriesTheLock pins the wire half of doc §4.2: a locked
// session must say so, in the snake_case names the rest of the projection uses,
// and the anonymous body (a frozen byte contract) must not grow the fields.
func TestSessionWireCarriesTheLock(t *testing.T) {
	raw, err := json.Marshal(sessionWire{Data: sessionDataWire{
		Authenticated:      true,
		Workspaces:         []workspaceWire{},
		UnusableWorkspaces: []workspaceWire{},
		AccountKind:        string(AccountKindSupplier),
		MustChangePassword: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"\"account_kind\":\"supplier\"", "\"must_change_password\":true"} {
		if !bytes.Contains(raw, []byte(want)) {
			t.Fatalf("session body %s missing %s", raw, want)
		}
	}
	if bytes.Contains(raw, []byte("accountKind")) || bytes.Contains(raw, []byte("mustChangePassword")) {
		t.Fatalf("camelCase leaked into the session body: %s", raw)
	}
	// False is omitted rather than sent as false: absence reads as false.
	unlocked, err := json.Marshal(sessionWire{Data: sessionDataWire{Authenticated: true, Workspaces: []workspaceWire{}, UnusableWorkspaces: []workspaceWire{}, AccountKind: string(AccountKindPlatform)}})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(unlocked, []byte("must_change_password")) {
		t.Fatalf("unlocked session must omit the flag: %s", unlocked)
	}
	anon := anonymousSessionBody()
	if bytes.Contains(anon, []byte("must_change_password")) || bytes.Contains(anon, []byte("account_kind")) {
		t.Fatalf("anonymous body changed: %s", anon)
	}
}

func TestAccountKindFromStored(t *testing.T) {
	cases := map[string]string{
		"supplier": "supplier", " Supplier ": "supplier", "SUPPLIER": "supplier",
		"platform": "platform", "": "platform", "   ": "platform",
		"vendor": "platform", "platform2": "platform",
	}
	for raw, want := range cases {
		if got := AccountKindFromStored(raw); got != want {
			t.Fatalf("%q -> %q want %q", raw, got, want)
		}
	}
	if !IsSupplierAccount("supplier") || IsSupplierAccount("platform") || IsSupplierAccount("") {
		t.Fatal("IsSupplierAccount")
	}
	if string(AccountKindPlatform) != "platform" || string(AccountKindSupplier) != "supplier" {
		t.Fatal("literals drifted from ck_account_users_kind")
	}
}
