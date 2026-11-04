package integration

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func runAdminConfigRuntimeCases(t *testing.T, f listingMediaTest, actual http.Handler) {
	t.Helper()
	t.Run("configuration_save_readback_normal_role", func(t *testing.T) {
		seedMatchingLease(t, f.ctx, f.pool, "admin", "configuration normal role test")
		spec, err := testkit.LoadOpenAPI()
		if err != nil {
			t.Fatal(err)
		}
		const path = "/api/admin/integrations/config"
		invoke := func(method, cookie, body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, path, strings.NewReader(body))
			req.Header.Set("Cookie", cookie)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			actual.ServeHTTP(rec, req)
			return rec
		}
		check := func(method string, rec *httptest.ResponseRecorder) {
			t.Helper()
			if rec.Code != 200 {
				t.Fatalf("normal role config %s %d %s", method, rec.Code, rec.Body.String())
			}
			if err := spec.CheckResponse(method, path, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
				t.Fatalf("config contract: %v\n%s", err, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "fixture-secret-only") || strings.Contains(rec.Body.String(), "api_key") {
				t.Fatal("configuration response included credentials")
			}
		}
		empty := invoke("GET", f.cookie, "")
		check("GET", empty)
		if !strings.Contains(empty.Body.String(), `"revision":0`) || !strings.Contains(empty.Body.String(), `"ai_accounts":[]`) {
			t.Fatalf("empty config %s", empty.Body.String())
		}
		body := `{"expected_revision":0,"ai_default_model":"recognition-test-model","ai_accounts":[{"id":"ai_recognition_fixture","label":"Integration fixture","base_url":"https://example.invalid/v1","api_format":"chat_completions","model":"recognition-test-model","api_key":"fixture-secret-only","active":true,"thinking":"disabled","thinking_format":"enable_thinking","priority":10,"purpose":"ocr"}],"ai_runtime":{"max_concurrency_global":6,"max_concurrency_user":2,"max_concurrency_account":3,"user_rate_per_minute":20,"lease_ttl_seconds":120,"allow_public_egress":true}}`
		saved := invoke("PUT", f.cookie, body)
		check("PUT", saved)
		defer f.pool.Exec(f.ctx, `DELETE FROM platform_integration_config`)
		if !strings.Contains(saved.Body.String(), `"revision":1`) || !strings.Contains(saved.Body.String(), `"thinking":"disabled"`) ||
			!strings.Contains(saved.Body.String(), `"purpose":"ocr"`) ||
			!strings.Contains(saved.Body.String(), `"ai_runtime":{"max_concurrency_global":6,"max_concurrency_user":2,"max_concurrency_account":3,"user_rate_per_minute":20,"lease_ttl_seconds":120,"allow_public_egress":true}`) {
			t.Fatalf("saved config %s", saved.Body.String())
		}
		readback := invoke("GET", f.cookie, "")
		check("GET", readback)
		if readback.Body.String() != saved.Body.String() {
			t.Fatalf("readback differs: %s != %s", readback.Body.String(), saved.Body.String())
		}
		var nonce, ciphertext []byte
		if err := f.pool.QueryRow(f.ctx, `SELECT nonce,ciphertext FROM platform_integration_config`).Scan(&nonce, &ciphertext); err != nil || len(nonce) != 12 || len(ciphertext) < 16 || strings.Contains(string(ciphertext), "fixture-secret-only") {
			t.Fatal("configuration was not persisted as ciphertext", err)
		}
		prices := get(t, actual, "/api/ai/prices", f.cookie)
		if prices.Code != 200 || !strings.Contains(prices.Body.String(), `"ocr_models":["recognition-test-model"]`) || !strings.Contains(prices.Body.String(), `"default_ocr_model":"recognition-test-model"`) {
			t.Fatalf("configured model not available to runtime %d %s", prices.Code, prices.Body.String())
		}
		if stale := invoke("PUT", f.cookie, body); stale.Code != 409 {
			t.Fatalf("stale replacement %d %s", stale.Code, stale.Body.String())
		}
		var updated map[string]any
		if err := json.Unmarshal([]byte(body), &updated); err != nil {
			t.Fatal(err)
		}
		updated["expected_revision"] = 1
		updated["ai_accounts"].([]any)[0].(map[string]any)["api_key"] = ""
		updatedBody, _ := json.Marshal(updated)
		check("PUT", invoke("PUT", f.cookie, string(updatedBody)))
		// The retry above omitted nothing; now omit ai_runtime and expect it retained.
		delete(updated, "ai_runtime")
		updated["expected_revision"] = 2
		retainedBody, _ := json.Marshal(updated)
		retained := invoke("PUT", f.cookie, string(retainedBody))
		check("PUT", retained)
		if !strings.Contains(retained.Body.String(), `"lease_ttl_seconds":120`) || !strings.Contains(retained.Body.String(), `"allow_public_egress":true`) {
			t.Fatalf("omitted ai_runtime was not retained: %s", retained.Body.String())
		}
		missingPurpose := strings.Replace(string(retainedBody), `"expected_revision":2`, `"expected_revision":3`, 1)
		missingPurpose = strings.Replace(missingPurpose, `"purpose":"ocr"`, `"purpose":"chat"`, 1)
		if bad := invoke("PUT", f.cookie, missingPurpose); bad.Code != 400 {
			t.Fatalf("unknown purpose accepted %d %s", bad.Code, bad.Body.String())
		}
		if member := invoke("GET", f.other, ""); member.Code != 403 {
			t.Fatalf("member config visibility %d %s", member.Code, member.Body.String())
		}
		if old := get(t, actual, "/api/integrations/config", f.cookie); old.Code != 404 {
			t.Fatalf("retired config path %d %s", old.Code, old.Body.String())
		}
		var requests int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM ai_requests`).Scan(&requests); err != nil || requests != 0 {
			t.Fatal("configuration issued an AI request", requests, err)
		}
	})
	t.Run("system_storage_manual_configuration", func(t *testing.T) {
		seedMatchingLease(t, f.ctx, f.pool, "admin", "system storage test")
		defer f.pool.Exec(f.ctx, `DELETE FROM platform_integration_config`)
		invoke := func(method, cookie, body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, "/api/admin/integrations/config", strings.NewReader(body))
			req.Header.Set("Cookie", cookie)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			actual.ServeHTTP(rec, req)
			return rec
		}
		body := `{"expected_revision":0,"ai_accounts":[],"system_storage":[{"role":"assets","endpoint":"https://account.r2.cloudflarestorage.com","bucket":"podhub-test-supplier","public_base_url":"https://pub-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.dev","access_key_id":"test-access","secret_access_key":"test-storage-secret"}]}`
		saved := invoke("PUT", f.cookie, body)
		if saved.Code != 200 || strings.Contains(saved.Body.String(), "test-access") || strings.Contains(saved.Body.String(), "test-storage-secret") || strings.Contains(saved.Body.String(), `"key_prefix"`) || strings.Contains(saved.Body.String(), `"session_token"`) || !strings.Contains(saved.Body.String(), `"bucket":"podhub-test-supplier"`) {
			t.Fatalf("save exposed or lost credentials: %d %s", saved.Code, saved.Body.String())
		}
		if member := invoke("GET", f.other, ""); member.Code != 403 {
			t.Fatalf("member storage access %d", member.Code)
		}
		if stale := invoke("PUT", f.cookie, body); stale.Code != 409 {
			t.Fatalf("stale storage write %d", stale.Code)
		}
		var replacement map[string]any
		if err := json.Unmarshal([]byte(body), &replacement); err != nil {
			t.Fatal(err)
		}
		replacement["expected_revision"] = 1
		row := replacement["system_storage"].([]any)[0].(map[string]any)
		row["access_key_id"], row["secret_access_key"] = "", ""
		updated, _ := json.Marshal(replacement)
		if rec := invoke("PUT", f.cookie, string(updated)); rec.Code != 200 {
			t.Fatalf("blank credential retention %d %s", rec.Code, rec.Body.String())
		}
		var nonce, ciphertext []byte
		if err := f.pool.QueryRow(f.ctx, `SELECT nonce,ciphertext FROM platform_integration_config`).Scan(&nonce, &ciphertext); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(ciphertext), "test-storage-secret") {
			t.Fatal("storage secret stored in plaintext")
		}
		key, err := seal.IntegrationKEK(strings.Repeat("recognition-test-key-", 3))
		if err != nil {
			t.Fatal(err)
		}
		plain, err := seal.OpenIntegration(key, nonce, ciphertext)
		if err != nil {
			t.Fatal(err)
		}
		snapshot, _, err := configdoc.ParseStored(plain)
		if err != nil || len(snapshot.SystemStorage) != 1 || snapshot.SystemStorage[0].SecretAccessKey != "test-storage-secret" || snapshot.SystemStorage[0].ID != "s3_assets" {
			t.Fatal("saved credentials were not retained")
		}
		row["endpoint"] = "https://other.r2.cloudflarestorage.com"
		replacement["expected_revision"] = 2
		updated, _ = json.Marshal(replacement)
		if rec := invoke("PUT", f.cookie, string(updated)); rec.Code != 400 {
			t.Fatalf("endpoint change reused secrets: %d", rec.Code)
		}
		if rec := invoke("PUT", f.cookie, `{"expected_revision":2,"ai_accounts":[]}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"bucket":"podhub-test-supplier"`) {
			t.Fatalf("AI-only save lost system storage: %d %s", rec.Code, rec.Body.String())
		}
	})
}
