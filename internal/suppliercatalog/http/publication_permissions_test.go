package cataloghttp

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSourceMaintenanceDoesNotGrantPublication(t *testing.T) {
	for _, role := range []string{"", "user", "admin"} {
		for _, action := range []string{"publish", "unpublish"} {
			t.Run(role+"/"+action, func(t *testing.T) {
				actions := &stubActions{}
				router := newRouter(t, actions, stubSession{p: &Principal{UserID: 1, PlatformRole: role}})
				reply := httptest.NewRecorder()
				router.ServeHTTP(reply, httptest.NewRequest(http.MethodPost, "/api/supplier-catalog/sources/src/rows/p/"+action, nil))
				if reply.Code != http.StatusForbidden || actions.last != "" {
					t.Fatalf("publication reached action=%q status=%d", actions.last, reply.Code)
				}
			})
		}
	}
}
