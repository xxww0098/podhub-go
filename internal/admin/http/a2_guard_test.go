package adminhttp

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestA2GatesBeforePort(t *testing.T) {
	super := Session{UserID: 1, OrgID: 1, PlatformRole: "super_admin", PublicID: "usr"}
	staff := Session{UserID: 2, OrgID: 1, PlatformRole: "admin"}
	ready := super
	ready.TotpEnrolled = true
	ready.StepUpElevated = true

	r := chi.NewRouter()
	Mount(r, Deps{Resolve: func(*http.Request) (*Session, *Refusal, error) {
		return &super, nil, nil
	}})
	rec := call(r, http.MethodGet, "/api/admin/platform-catalog", "")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "请先绑定验证器") || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("totp %d %s", rec.Code, rec.Body.String())
	}

	r = chi.NewRouter()
	step := super
	step.TotpEnrolled = true
	Mount(r, Deps{Resolve: func(*http.Request) (*Session, *Refusal, error) {
		return &step, nil, nil
	}})
	rec = call(r, http.MethodGet, "/api/admin/agents", "")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "管理操作需要重新验证") {
		t.Fatalf("step %d %s", rec.Code, rec.Body.String())
	}

	r = chi.NewRouter()
	Mount(r, Deps{Resolve: func(*http.Request) (*Session, *Refusal, error) {
		return &staff, nil, nil
	}})
	rec = call(r, http.MethodGet, "/api/admin/agents", "")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "需要超级管理员权限") {
		t.Fatalf("role %d %s", rec.Code, rec.Body.String())
	}
	rec = call(r, http.MethodGet, "/api/admin/delegate-orders", "")
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"code":"not_ported"`) {
		t.Fatalf("staff delegate %d %s", rec.Code, rec.Body.String())
	}

	r = chi.NewRouter()
	Mount(r, Deps{Resolve: func(*http.Request) (*Session, *Refusal, error) {
		return &ready, nil, nil
	}})
	rec = call(r, http.MethodPost, "/api/admin/delegate-orders/not-a-uuid/dispatch", "")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("ready delegate still needs a service, got %d %s", rec.Code, rec.Body.String())
	}
	rec = call(r, http.MethodGet, "/api/admin/agent-withdrawals", "")
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"code":"not_ported"`) {
		t.Fatalf("agents service %d %s", rec.Code, rec.Body.String())
	}
}
