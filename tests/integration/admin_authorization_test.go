package integration

import (
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestAdminAPIRoutesRejectNonStaff(t *testing.T) {
	f := newAdminContentFixture(t)
	routes, ok := f.handler.(chi.Routes)
	if !ok {
		t.Fatalf("handler does not expose mounted routes: %T", f.handler)
	}
	param := regexp.MustCompile(`\{[^}]+\}`)
	checked := 0
	err := chi.Walk(routes, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(path, "/api/admin/") {
			return nil
		}
		path = param.ReplaceAllString(path, "1")
		body := `{"name":"test"}`
		if strings.HasSuffix(path, "/pay") {
			body = `{"reference":"test"}`
		} else if strings.HasSuffix(path, "/reject") {
			body = `{"reason":"test"}`
		}
		for _, actor := range []struct {
			token string
			want  int
		}{{"", http.StatusUnauthorized}, {f.user, http.StatusForbidden}} {
			status, raw := f.call(t, method, path, body, actor.token)
			if status != actor.want {
				t.Errorf("%s %s authenticated=%t: %d %s; want %d", method, path, actor.token != "", status, raw, actor.want)
			}
		}
		checked++
		return nil
	})
	if err != nil || checked == 0 {
		t.Fatalf("walked admin routes=%d: %v", checked, err)
	}
	t.Logf("checked %d mounted admin operations with anonymous and ordinary sessions", checked)
	f.assertClean(t)
}
