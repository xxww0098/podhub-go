package adminhttp

import (
	"net/http"
	"strings"
	"testing"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestEveryAdminRouteRejectsNonStaff(t *testing.T) {
	for _, workspaceRole := range []string{"", "owner", "manager", "member"} {
		var p *access.Principal
		want := http.StatusUnauthorized
		if workspaceRole != "" {
			p = &access.Principal{UserID: 1, OrgID: 1, PlatformRole: "user", WorkspaceRole: workspaceRole}
			want = http.StatusForbidden
		}
		r := router(access.FixedResolver{Principal: p})
		for _, rt := range Routes() {
			if !strings.HasPrefix(rt.Path, "/api/admin/") {
				continue
			}
			body := `{"name":"test"}`
			if strings.HasSuffix(rt.Path, "/pay") {
				body = `{"reference":"test"}`
			} else if strings.HasSuffix(rt.Path, "/reject") {
				body = `{"reason":"test"}`
			}
			rec := call(r, rt.Method, rt.Path, body)
			if rec.Code != want {
				t.Errorf("%s %s workspace=%q: %d %s; want %d", rt.Method, rt.Path, workspaceRole, rec.Code, rec.Body.String(), want)
			}
		}
	}
}
