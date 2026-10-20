package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgentRoutesAreMounted(t *testing.T) {
	handler := Handler(nil)
	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/agent"},
		{http.MethodPost, "/api/agent/claim"},
		{http.MethodGet, "/api/agent/ledger"},
		{http.MethodPut, "/api/agent/payout-account"},
		{http.MethodPost, "/api/agent/wallet-transfers"},
		{http.MethodGet, "/api/agent/withdrawals"},
		{http.MethodPost, "/api/agent/withdrawals"},
	}
	for _, rt := range routes {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(rt.method, rt.path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: %d %s", rt.method, rt.path, rec.Code, rec.Body)
		}
		if rec.Body.String() != `{"error":"未登录","code":"AUTH_REQUIRED"}` {
			t.Fatalf("%s %s body %s", rt.method, rt.path, rec.Body)
		}
	}
}
