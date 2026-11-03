package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type workspaceCFTransport func(*http.Request) (*http.Response, error)

func (f workspaceCFTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWorkspaceSliceProvisionResumesWithoutDuplicatingBucketOrCredential(t *testing.T) {
	for _, tc := range []struct {
		name, custom                                   string
		uncertainCredential, uncertainCreate, conflict bool
	}{
		{name: "default name retries verification"},
		{name: "custom name retries verification", custom: "team-slices"},
		{name: "unknown credential requires review", uncertainCredential: true},
		{name: "unknown custom creation requires review", custom: "team-slices", uncertainCreate: true},
		{name: "name conflict permits another name", custom: "team-slices", conflict: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			pool := migratedPool(t, ctx)
			owner, org, workspace := securityOrg(t, ctx, pool, "slice-provision")
			insertMember(t, ctx, pool, org, owner, "owner", 1)
			hxExec(t, ctx, pool, `UPDATE account_profiles SET active_org_id=$2 WHERE user_id=$1`, owner, org)
			tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace)))
			hxExec(t, ctx, pool, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($2,$1,clock_timestamp()+interval '1 hour')`, owner, tokenHash)
			seedMatchingLease(t, ctx, pool, "recipe", "workspace storage provisioning")
			const accountID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			const path = "/api/workspace/slice-storage"
			var bucket string
			creates, tokens, probes := 0, 0, 0
			upstream := workspaceCFTransport(func(r *http.Request) (*http.Response, error) {
				status, body := 200, `{"success":true,"result":{}}`
				switch {
				case r.URL.Path == "/oauth2/token":
					body = `{"access_token":"setup-token","token_type":"Bearer","expires_in":3600}`
				case strings.HasSuffix(r.URL.Path, "/r2/buckets") && r.Method == "POST":
					var in struct {
						Name string `json:"name"`
					}
					if json.NewDecoder(r.Body).Decode(&in) != nil || (tc.custom == "" && !strings.HasPrefix(in.Name, "podhub-")) || (tc.custom != "" && in.Name != tc.custom) {
						t.Fatal("invalid generated bucket")
					}
					bucket = in.Name
					creates++
					body = `{"success":true,"result":{"name":"` + bucket + `"}}`
					if tc.conflict {
						status, body = 409, `{"success":false,"errors":[{"code":10004}]}`
					} else if tc.uncertainCreate {
						status, body = 503, `{"success":false}`
					}
				case strings.HasSuffix(r.URL.Path, "/r2/buckets/"+bucket) && r.Method == "GET":
					body = `{"success":true,"result":{"name":"` + bucket + `"}}`
				case strings.HasSuffix(r.URL.Path, "/cors"):
				case strings.HasSuffix(r.URL.Path, "/domains/managed"):
					body = `{"success":true,"result":{"enabled":true,"domain":"pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"}}`
				case strings.HasSuffix(r.URL.Path, "/tokens/permission_groups"):
					body = `{"success":true,"result":[{"id":"cccccccccccccccccccccccccccccccc","name":"Workers R2 Storage Bucket Item Write"}]}`
				case strings.HasSuffix(r.URL.Path, "/tokens") && r.Method == "POST":
					tokens++
					body = `{"success":true,"result":{"id":"dddddddddddddddddddddddddddddddd","value":"bucket-secret"}}`
					if tc.uncertainCredential {
						status, body = 503, `{"success":false}`
					}
				default:
					t.Fatalf("unexpected upstream %s %s", r.Method, r.URL.Path)
				}
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			principal := &access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: tokenHash}
			s := &httpapi.Server{Pool: pool, Access: access.FixedResolver{Principal: principal}, SliceStorageKey: []byte(strings.Repeat("k", 32)), SliceDeleteAllowed: true, PublicURL: "https://podhub.example", Cloudflare: cloudflare.New(upstream), CloudflareOAuth: cloudflare.OAuth{ClientID: "podhub", ClientSecret: "secret", Scopes: "test-r2-scope", RedirectURL: "https://podhub.example" + path + "/cloudflare/callback"}}
			s.VerifySlice = func(_ context.Context, a sign.Account, w, origin string) (bool, error) {
				probes++
				if a.Bucket != bucket || a.SecretAccessKey == "" || a.AccessKeyID != strings.Repeat("d", 32) || a.KeyPrefix != "podhub-slices/"+a.ID+"/" || w != workspace || origin != s.PublicURL {
					t.Fatal("persisted candidate differs from the provisioned bucket")
				}
				if probes == 1 {
					return false, errors.New("simulated readback failure")
				}
				return true, nil
			}
			handler := httpapi.HandlerFromMux(s, nil)
			call := func(method, target, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "https://podhub.example"+target, strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
				for _, cookie := range cookies {
					r.AddCookie(cookie)
				}
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}
			start := call("POST", path+"/cloudflare/authorize", "")
			var auth struct {
				URL string `json:"authorization_url"`
			}
			if start.Code != 200 || json.Unmarshal(start.Body.Bytes(), &auth) != nil {
				t.Fatalf("authorize: %d %s", start.Code, start.Body.String())
			}
			u, _ := url.Parse(auth.URL)
			callback := call("GET", path+"/cloudflare/callback?code=test&state="+u.Query().Get("state"), "", start.Result().Cookies()...)
			if callback.Code != 303 {
				t.Fatalf("callback: %d %s", callback.Code, callback.Body.String())
			}
			var grant *http.Cookie
			for _, cookie := range callback.Result().Cookies() {
				if cookie.Name == "podhub_cf_token" {
					grant = cookie
				}
			}
			if grant == nil || grant.Path != path {
				t.Fatal("setup grant does not cover the provisioning request")
			}
			bodyFor := func(name string) string {
				in := map[string]any{"account_id": accountID, "public_access": true}
				if name != "" {
					in["bucket"] = name
				}
				raw, _ := json.Marshal(in)
				return string(raw)
			}
			for _, invalid := range []string{"中文存储桶", "Team-assets", "has space", "-starts", "ends-", "ab", strings.Repeat("a", 64)} {
				bad := call("POST", path, bodyFor(invalid), grant)
				if bad.Code != 400 || !strings.Contains(bad.Body.String(), "WORKSPACE_STORAGE_BUCKET_INVALID") || creates != 0 {
					t.Fatalf("invalid name reached creation: %q %d %s", invalid, bad.Code, bad.Body.String())
				}
			}
			body := bodyFor(tc.custom)
			first := call("POST", path, body, grant)
			if first.Code == 200 {
				t.Fatal("an unverified bucket was activated")
			}
			if tc.uncertainCreate {
				second := call("POST", path, body, grant)
				if second.Code != 409 || creates != 1 || tokens != 0 || probes != 0 {
					t.Fatalf("ambiguous custom bucket was adopted or recreated: %d %s", second.Code, second.Body.String())
				}
				return
			}
			wantCreates := 1
			if tc.conflict {
				if first.Code != 409 || !strings.Contains(first.Body.String(), "WORKSPACE_STORAGE_BUCKET_EXISTS") {
					t.Fatalf("conflict: %d %s", first.Code, first.Body.String())
				}
				tc.conflict = false
				tc.custom = "another-team-slices"
				body = bodyFor(tc.custom)
				first = call("POST", path, body, grant)
				if first.Code == 200 {
					t.Fatal("unverified replacement name was activated")
				}
				wantCreates = 2
			}
			changed := call("POST", path, bodyFor("changed-after-start"), grant)
			if changed.Code != 409 || !strings.Contains(changed.Body.String(), "WORKSPACE_STORAGE_BUCKET_FIXED") {
				t.Fatalf("pending name was editable: %d %s", changed.Code, changed.Body.String())
			}
			second := call("POST", path, body, grant)
			if tc.uncertainCredential {
				if second.Code != 409 || probes != 0 {
					t.Fatalf("unknown credential retried: %d %s", second.Code, second.Body.String())
				}
			} else {
				if second.Code != 200 || !strings.Contains(second.Body.String(), `"configured":true`) || probes != 2 {
					t.Fatalf("resume: %d %s", second.Code, second.Body.String())
				}
				if !strings.Contains(second.Body.String(), `"oauth_available":true`) || !strings.Contains(second.Body.String(), `"cloudflare_connected":true`) || second.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("active bucket must retain session connection status: %s", second.Body.String())
				}
				if disconnected := call("GET", path, ""); !strings.Contains(disconnected.Body.String(), `"cloudflare_connected":false`) {
					t.Fatalf("missing session grant: %d %s", disconnected.Code, disconnected.Body.String())
				}
				if again := call("POST", path, body); again.Code != 200 {
					t.Fatalf("ready bucket retry: %d %s", again.Code, again.Body.String())
				}
				if changed := call("POST", path, bodyFor("changed-after-ready")); changed.Code != 409 {
					t.Fatalf("active name was editable: %d %s", changed.Code, changed.Body.String())
				}
			}
			if creates != wantCreates || tokens != 1 {
				t.Fatalf("duplicate external writes: buckets=%d tokens=%d", creates, tokens)
			}
			if strings.Contains(second.Body.String(), "bucket-secret") || strings.Contains(second.Body.String(), "setup-token") {
				t.Fatal("response exposed credentials")
			}
			err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
				active, err := mediarepo.ActiveSliceStorage(ctx, tx, org, s.SliceStorageKey)
				if (active != nil) == tc.uncertainCredential {
					t.Fatal("persisted activation disagrees with verification")
				}
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
