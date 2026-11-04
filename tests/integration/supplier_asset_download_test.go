package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"golang.org/x/crypto/bcrypt"
)

func TestSupplierAssetDownloadNormalRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_PARITY_DSN", dsn)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	f := newFulfillerFixture(t, false)
	dispatch := f.dispatch(t)
	imageID, psdID := uuid.NewString(), uuid.NewString()
	digest := strings.Repeat("a", 64)
	key := "test-prefix/original.png"
	payload, err := json.Marshal(map[string]any{"lines": []any{map[string]any{
		"offer_id": "FULFILLER-OFFER", "quantity": 1,
		"assets": []any{
			map[string]any{"asset_id": imageID, "object_key": key, "file_name": "生产图.png", "sha256": digest, "bytes": 500 << 20, "mime": "image/png"},
			map[string]any{"asset_id": psdID, "object_key": "test-prefix/template.psd", "file_name": "template.psd", "sha256": digest, "bytes": 500 << 20, "mime": "text/html"},
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE delegate_dispatches SET payload=$2::jsonb,nudge_count=1 WHERE dispatch_id=$1::uuid`, dispatch, payload)
	bucket := configdoc.StoredStorage{
		ID: "private-download", Role: "private",
		Endpoint: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", KeyPrefix: "test-prefix/",
		AccessKeyID: "DOWNLOADTEST", SecretAccessKey: "isolated-download-secret",
	}
	setR2StorageAccount(t, f.pool, bucket)
	hash, err := bcrypt.GenerateFromPassword([]byte("private-download-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE account_users SET password_hash=$1 WHERE id=ANY($2::bigint[])`, string(hash), []int64{f.user, f.owner})
	f.exec(t, `ALTER ROLE podhub_login_api PASSWORD 'isolated-private-download'`)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	apiDSN, err := url.Parse(swapUser(f.pool.Config().ConnString(), "podhub_login_api", "isolated-private-download"))
	if err != nil {
		t.Fatal(err)
	}
	query := apiDSN.Query()
	query.Set("pool_max_conns", "1")
	apiDSN.RawQuery = query.Encode()
	api, err := db.Connect(ctx, config.Config{DatabaseURL: apiDSN.String()})
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	handler := app.Handler(api)
	login := func(user int64) string {
		t.Helper()
		var email string
		if err := f.pool.QueryRow(ctx, `SELECT email FROM account_users WHERE id=$1`, user).Scan(&email); err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]string{"email": email, "password": "private-download-password"})
		rec := postJSON(t, handler, "/api/auth/login", string(body), uuid.NewString(), "")
		if rec.Code != 200 {
			t.Fatalf("supplier login failed: %d %s", rec.Code, rec.Body.String())
		}
		for _, cookie := range rec.Result().Cookies() {
			if cookie.Name == "sid" {
				return cookie.Value
			}
		}
		t.Fatal("login did not return a session cookie")
		return ""
	}
	supplierToken, otherToken := login(f.user), login(f.owner)
	base := "/api/supplier/dispatches/" + dispatch + "/assets/"
	request := func(path, token, accept string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "sid", Value: token})
		}
		req.Header.Set("Accept", accept)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "private, no-store" || rec.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("private response headers missing: %d", rec.Code)
		}
		return rec
	}
	for _, kind := range []string{"dispatches?view=pending", "dashboard"} {
		path := "/api/supplier/workspaces/" + f.source + "/" + kind
		get := func(token string) *httptest.ResponseRecorder {
			t.Helper()
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.AddCookie(&http.Cookie{Name: "sid", Value: token})
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			return rec
		}
		rec := get(supplierToken)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", kind, rec.Code, rec.Body.String())
		}
		var response struct {
			Data struct {
				Dispatches   []contract.DispatchRow `json:"dispatches"`
				UrgentOrders []contract.DispatchRow `json:"urgent_orders"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		rows := response.Data.Dispatches
		if kind == "dashboard" {
			rows = response.Data.UrgentOrders
		}
		if len(rows) != 1 || rows[0].ThumbnailURL == nil || *rows[0].ThumbnailURL != base+imageID {
			t.Fatalf("%s thumbnail: %s", kind, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "object_key") || strings.Contains(rec.Body.String(), key) {
			t.Fatalf("private asset data in %s: %s", kind, rec.Body.String())
		}
		other := get(otherToken)
		if other.Code == http.StatusOK || strings.Contains(other.Body.String(), imageID) || strings.Contains(other.Body.String(), key) {
			t.Fatalf("other account read %s: %d %s", kind, other.Code, other.Body.String())
		}
	}
	for _, tc := range []struct {
		name, id, accept, disposition, kind string
		status                              int
	}{
		{"image preview", imageID, "image/*", "inline", "image/png", http.StatusTemporaryRedirect},
		{"image download", imageID, "application/json", "attachment", "image/png", http.StatusOK},
		{"unsafe MIME", psdID, "*/*", "attachment", "application/octet-stream", http.StatusTemporaryRedirect},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := request(base+tc.id, supplierToken, tc.accept)
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			raw := rec.Header().Get("Location")
			var expiresAtMs int64
			if tc.status == http.StatusOK {
				var reply struct{ Data contract.DownloadGrant }
				if json.Unmarshal(rec.Body.Bytes(), &reply) != nil || reply.Data.Bytes != 500<<20 || reply.Data.SHA256 != digest {
					t.Fatal("invalid 500 MiB grant")
				}
				expiresAtMs = reply.Data.ExpiresAtMs
				raw = reply.Data.URL
			}
			u, err := url.Parse(raw)
			if err != nil || u.Scheme != "https" || u.Host != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com" || !strings.HasPrefix(u.Path, "/podhub-go-private/test-prefix/") {
				t.Fatal("grant did not use the configured private bucket")
			}
			q := u.Query()
			stamp, err := time.Parse("20060102T150405Z", q.Get("X-Amz-Date"))
			if err != nil || (expiresAtMs != 0 && expiresAtMs != stamp.Add(120*time.Second).UnixMilli()) {
				t.Fatal("grant expiration differs from the signed lifetime")
			}
			if q.Get("response-cache-control") != "private, no-store" || q.Get("response-content-type") != tc.kind || !strings.HasPrefix(q.Get("response-content-disposition"), tc.disposition+";") || q.Get("X-Amz-Expires") != "120" || q.Get("X-Amz-Signature") == "" {
				t.Fatal("private grant policy missing")
			}
			if q.Get("X-Amz-SignedHeaders") != "host" {
				t.Fatal("Range must remain selectable by the object client")
			}
		})
	}
	for _, tc := range []struct {
		name, path, token string
		status            int
	}{
		{"anonymous", base + imageID, "", http.StatusUnauthorized},
		{"other account", base + imageID, otherToken, http.StatusNotFound},
		{"missing asset", base + uuid.NewString(), supplierToken, http.StatusNotFound},
		{"other dispatch", "/api/supplier/dispatches/" + uuid.NewString() + "/assets/" + imageID, supplierToken, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := request(tc.path, tc.token, "application/json")
			if rec.Code != tc.status || rec.Header().Get("Location") != "" || strings.Contains(rec.Body.String(), "X-Amz-") {
				t.Fatalf("refusal status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
	bucket.AccessKeyID = "ROTATED"
	setR2StorageAccount(t, f.pool, bucket)
	if rec := request(base+imageID, supplierToken, "*/*"); rec.Code != 307 || !strings.Contains(rec.Header().Get("Location"), "X-Amz-Credential=ROTATED") {
		t.Fatal("download retained stale storage credentials")
	}
	setR2StorageAccount(t, f.pool, configdoc.StoredStorage{Role: "private"})
	if rec := request(base+imageID, supplierToken, "*/*"); rec.Code != 503 || rec.Header().Get("Location") != "" {
		t.Fatal("inactive private storage issued a grant")
	}
	bucket.Endpoint = "https://untrusted.example"
	setR2StorageAccount(t, f.pool, bucket)
	if rec := request(base+imageID, supplierToken, "*/*"); rec.Code != 503 || rec.Header().Get("Location") != "" {
		t.Fatal("untrusted storage endpoint issued a grant")
	}
	var role string
	if err = api.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil || role != "podhub_login_api" {
		t.Fatal("database role leaked after download")
	}
	if _, err = api.Exec(ctx, `SELECT nonce FROM platform_integration_config`); err == nil {
		t.Fatal("API login gained direct configuration access")
	}
}
