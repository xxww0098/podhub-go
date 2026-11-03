package adminhttp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func TestConfigRejectsStorageSettings(t *testing.T) {
	h := handler{Deps: Deps{API: &service.API{}}}
	for _, field := range []string{
		"storageBuckets", "storage_buckets", "mediaAccounts", "media_accounts",
		"supplierDbStorage", "supplier_db_storage", "delegateAssetsStorage", "delegate_assets_storage",
	} {
		t.Run(field, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, "/api/admin/integrations/config",
				strings.NewReader(`{"expected_revision":0,"ai_accounts":[],"`+field+`":[]}`))
			r.Header.Set("Content-Type", "application/json")
			_, fault := h.replaceConfig(r, domain.Actor{})
			if fault == nil || fault.Status != http.StatusBadRequest {
				t.Fatalf("storage settings must be rejected, got %+v", fault)
			}
		})
	}
	r := httptest.NewRequest(http.MethodPut, "/api/admin/integrations/config", strings.NewReader(`{"expected_revision":0,"ai_accounts":[]}`))
	r.Header.Set("Content-Type", "application/json")
	_, fault := h.replaceConfig(r, domain.Actor{})
	if fault == nil || fault.Status != http.StatusServiceUnavailable {
		t.Fatalf("AI-only body should reach service configuration validation, got %+v", fault)
	}
}

func replaceBody(t *testing.T, body string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, "/api/admin/integrations/config", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestConfigDecodeRequiresPurposeAndStrictRuntime(t *testing.T) {
	h := handler{Deps: Deps{API: &service.API{}}}
	account := func(extra string) string {
		return `{"id":"a","label":"A","base_url":"https://x.example/v1","api_format":"chat_completions","model":"m","api_key":"k","active":true` + extra + `}`
	}
	const runtime = `{"max_concurrency_global":1,"max_concurrency_user":2,"max_concurrency_account":3,"user_rate_per_minute":4,"lease_ttl_seconds":90,"allow_public_egress":false}`
	for name, body := range map[string]string{
		"missing purpose":      `{"expected_revision":0,"ai_accounts":[` + account("") + `]}`,
		"non-string purpose":   `{"expected_revision":0,"ai_accounts":[` + account(`,"purpose":1`) + `]}`,
		"runtime null":         `{"expected_revision":0,"ai_accounts":[],"ai_runtime":null}`,
		"runtime unknown key":  `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"allow_public_egress":false`, `"allow_public_egress":false,"x":1`, 1) + `}`,
		"runtime missing key":  `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"lease_ttl_seconds":90,`, ``, 1) + `}`,
		"runtime string count": `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"max_concurrency_user":2`, `"max_concurrency_user":"2"`, 1) + `}`,
		"runtime fraction":     `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"max_concurrency_user":2`, `"max_concurrency_user":2.5`, 1) + `}`,
		"runtime int32 over":   `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"max_concurrency_user":2`, `"max_concurrency_user":2147483648`, 1) + `}`,
		"runtime bool wrong":   `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"allow_public_egress":false`, `"allow_public_egress":"no"`, 1) + `}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, fault := h.replaceConfig(replaceBody(t, body), domain.Actor{})
			if fault == nil || fault.Status != http.StatusBadRequest {
				t.Fatalf("must be rejected as an invalid body, got %+v", fault)
			}
		})
	}
	for name, body := range map[string]string{
		"purpose ocr":   `{"expected_revision":0,"ai_accounts":[` + account(`,"purpose":"ocr"`) + `]}`,
		"purpose image": `{"expected_revision":0,"ai_accounts":[` + account(`,"purpose":"image"`) + `]}`,
		"with runtime":  `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + runtime + `}`,
		// An out-of-range value is a service validation matter, not a decode one.
		"runtime range": `{"expected_revision":0,"ai_accounts":[],"ai_runtime":` + strings.Replace(runtime, `"lease_ttl_seconds":90`, `"lease_ttl_seconds":0`, 1) + `}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, fault := h.replaceConfig(replaceBody(t, body), domain.Actor{})
			if fault == nil || fault.Status != http.StatusServiceUnavailable {
				t.Fatalf("decoded body should reach the service, got %+v", fault)
			}
		})
	}
}
