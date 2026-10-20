package api

import (
	"os"
	"strings"
	"testing"

	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	automationhttp "github.com/xxww0098/podhub-go/internal/automation/http"
	opshttp "github.com/xxww0098/podhub-go/internal/ops/http"
	telemetryhttp "github.com/xxww0098/podhub-go/internal/telemetry/http"
)

func TestPR8BOperationsAreInOpenAPI(t *testing.T) {
	raw, err := os.ReadFile("../../../api/openapi.yaml")
	if err != nil {
		raw, err = os.ReadFile("api/openapi.yaml")
	}
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	var routes []struct{ id, path string }
	for _, rt := range opshttp.Routes() {
		routes = append(routes, struct{ id, path string }{rt.OperationID, rt.Path})
	}
	for _, rt := range automationhttp.Routes() {
		routes = append(routes, struct{ id, path string }{rt.OperationID, rt.Path})
	}
	for _, rt := range telemetryhttp.Routes() {
		routes = append(routes, struct{ id, path string }{rt.OperationID, rt.Path})
	}
	for _, rt := range adminhttp.Routes() {
		routes = append(routes, struct{ id, path string }{rt.OperationID, rt.Path})
		if strings.Contains(rt.Path, "banned-tags") {
			t.Fatal(rt.Path)
		}
	}
	if len(routes) != 18+13+2+40+3+76 {
		t.Fatalf("routes %d", len(routes))
	}
	for _, rt := range routes {
		if !strings.Contains(text, "operationId: "+rt.id+"\n") {
			t.Fatalf("missing operation %s", rt.id)
		}
		if !strings.Contains(text, "  \""+rt.path+"\":\n") {
			t.Fatalf("missing path %s", rt.path)
		}
	}
}
