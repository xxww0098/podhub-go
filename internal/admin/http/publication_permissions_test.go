package adminhttp

import (
	"net/http"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func TestSupplierPublicationAndPlatformPriceRequireSuperAdmin(t *testing.T) {
	for _, role := range []string{"user", "admin", "super_admin"} {
		for _, action := range []string{"publish", "unpublish", "price"} {
			t.Run(role+"/"+action, func(t *testing.T) {
				router := mountX1(service.Service{Cat: &x1Cat{}}, role)
				body := ""
				if action == "price" {
					body = `{"priceCents":1200,"note":"test"}`
				}
				reply := jsonCall(router, http.MethodPost, "/api/admin/supplier-dbs/src/rows/p1/"+action, body)
				want := http.StatusForbidden
				if role == "super_admin" {
					want = http.StatusOK
				}
				if reply.Code != want {
					t.Fatalf("status=%d want=%d body=%s", reply.Code, want, reply.Body.String())
				}
			})
		}
	}
}
