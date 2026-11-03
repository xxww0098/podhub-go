package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const workspaceSlicePath = "/api/workspace/slice-storage"

type sliceWorkspace struct {
	owner     int64
	org       int64
	workspace string
	principal *access.Principal
}

func newSliceWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) sliceWorkspace {
	t.Helper()
	owner, org, workspace := securityOrg(t, ctx, pool, tag)
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	hxExec(t, ctx, pool, `UPDATE account_profiles SET active_org_id=$2 WHERE user_id=$1`, owner, org)
	tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace)))
	hxExec(t, ctx, pool, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($2,$1,clock_timestamp()+interval '1 hour')`, owner, tokenHash)
	return sliceWorkspace{
		owner: owner, org: org, workspace: workspace,
		principal: &access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: tokenHash},
	}
}

func provisionSliceBucket(t *testing.T, pool *pgxpool.Pool, ws sliceWorkspace, transport http.RoundTripper) string {
	t.Helper()
	s := &httpapi.Server{
		Pool:               pool,
		Access:             access.FixedResolver{Principal: ws.principal},
		SliceStorageKey:    []byte(strings.Repeat("k", 32)),
		SliceDeleteAllowed: true,
		PublicURL:          "https://podhub.example",
		Cloudflare:         cloudflare.New(transport),
		CloudflareOAuth: cloudflare.OAuth{
			ClientID: "podhub", ClientSecret: "secret", Scopes: "test-r2-scope",
			RedirectURL: "https://podhub.example" + workspaceSlicePath + "/cloudflare/callback",
		},
	}
	s.VerifySlice = func(_ context.Context, account sign.Account, workspace, origin string) (bool, error) {
		if workspace != ws.workspace || origin != s.PublicURL || account.Bucket == "" || account.SecretAccessKey == "" {
			t.Fatalf("verification bound to another workspace: workspace=%q bucket=%q", workspace, account.Bucket)
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
	start := call(http.MethodPost, workspaceSlicePath+"/cloudflare/authorize", "")
	var auth struct {
		URL string `json:"authorization_url"`
	}
	if start.Code != http.StatusOK || json.Unmarshal(start.Body.Bytes(), &auth) != nil {
		t.Fatalf("authorize: %d %s", start.Code, start.Body.String())
	}
	authorization, err := url.Parse(auth.URL)
	if err != nil {
		t.Fatal(err)
	}
	callback := call(http.MethodGet, workspaceSlicePath+"/cloudflare/callback?code=test&state="+authorization.Query().Get("state"), "", start.Result().Cookies()...)
	if callback.Code != http.StatusSeeOther {
		t.Fatalf("callback: %d %s", callback.Code, callback.Body.String())
	}
	var grant *http.Cookie
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == "podhub_cf_token" {
			grant = cookie
		}
	}
	if grant == nil {
		t.Fatal("missing setup grant")
	}
	body, _ := json.Marshal(map[string]any{"account_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "public_access": true})
	resp := call(http.MethodPost, workspaceSlicePath, string(body), grant)
	var out struct {
		Configured bool   `json:"configured"`
		Bucket     string `json:"bucket"`
	}
	if resp.Code != http.StatusOK || json.Unmarshal(resp.Body.Bytes(), &out) != nil || !out.Configured || out.Bucket == "" {
		t.Fatalf("provision: %d %s", resp.Code, resp.Body.String())
	}
	return out.Bucket
}

// TestWorkspaceSliceProvisionCreatesIndependentBuckets provisions two
// workspaces in the same Cloudflare account and checks that each one gets its
// own bucket, own bucket-scoped credential, and own active configuration.
func TestWorkspaceSliceProvisionCreatesIndependentBuckets(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	first := newSliceWorkspace(t, ctx, pool, "slice-first")
	second := newSliceWorkspace(t, ctx, pool, "slice-second")
	seedMatchingLease(t, ctx, pool, "recipe", "workspace storage provisioning")

	var created, tokenIDs []string
	current := ""
	transport := workspaceCFTransport(func(r *http.Request) (*http.Response, error) {
		status, body := http.StatusOK, `{"success":true,"result":{}}`
		switch {
		case r.URL.Path == "/oauth2/token":
			body = `{"access_token":"setup-token","token_type":"Bearer","expires_in":3600}`
		case strings.HasSuffix(r.URL.Path, "/r2/buckets") && r.Method == http.MethodPost:
			var in struct {
				Name string `json:"name"`
			}
			if json.NewDecoder(r.Body).Decode(&in) != nil || in.Name == "" {
				t.Fatal("invalid bucket creation")
			}
			current = in.Name
			created = append(created, in.Name)
			body = `{"success":true,"result":{"name":"` + in.Name + `"}}`
		case strings.HasSuffix(r.URL.Path, "/r2/buckets/"+current) && r.Method == http.MethodGet:
			body = `{"success":true,"result":{"name":"` + current + `"}}`
		case strings.HasSuffix(r.URL.Path, "/cors"):
		case strings.HasSuffix(r.URL.Path, "/domains/managed"):
			body = `{"success":true,"result":{"enabled":true,"domain":"pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"}}`
		case strings.HasSuffix(r.URL.Path, "/tokens/permission_groups"):
			body = `{"success":true,"result":[{"id":"cccccccccccccccccccccccccccccccc","name":"Workers R2 Storage Bucket Item Write"}]}`
		case strings.HasSuffix(r.URL.Path, "/tokens") && r.Method == http.MethodPost:
			var in struct {
				Name     string `json:"name"`
				Policies []struct {
					Resources map[string]string `json:"resources"`
				} `json:"policies"`
			}
			if json.NewDecoder(r.Body).Decode(&in) != nil || in.Name != "PodHub "+current || len(in.Policies) != 1 {
				t.Fatalf("credential was not scoped to the created bucket")
			}
			resource := in.Policies[0].Resources["com.cloudflare.edge.r2.bucket.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_default_"+current]
			if resource != "*" {
				t.Fatal("credential policy names another bucket")
			}
			id := fmt.Sprintf("%032x", len(tokenIDs)+1)
			tokenIDs = append(tokenIDs, id)
			body = `{"success":true,"result":{"id":"` + id + `","value":"bucket-secret-` + id + `"}}`
		default:
			t.Fatalf("unexpected upstream %s %s", r.Method, r.URL.Path)
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})

	firstBucket := provisionSliceBucket(t, pool, first, transport)
	secondBucket := provisionSliceBucket(t, pool, second, transport)
	if firstBucket == secondBucket {
		t.Fatalf("two workspaces share bucket %q", firstBucket)
	}
	if len(created) != 2 || created[0] != firstBucket || created[1] != secondBucket {
		t.Fatalf("created buckets %v do not match workspace responses %q %q", created, firstBucket, secondBucket)
	}
	if len(tokenIDs) != 2 || tokenIDs[0] == tokenIDs[1] {
		t.Fatalf("workspaces share a bucket credential: %v", tokenIDs)
	}

	key := []byte(strings.Repeat("k", 32))
	for _, tc := range []struct {
		ws     sliceWorkspace
		bucket string
		other  int64
	}{
		{first, firstBucket, second.org},
		{second, secondBucket, first.org},
	} {
		err := db.InTx(ctx, pool, db.App(tc.ws.org), func(tx pgx.Tx) error {
			row, err := mediarepo.ActiveSliceStorage(ctx, tx, tc.ws.org, key)
			if err != nil {
				return err
			}
			if row == nil || row.Account.Bucket != tc.bucket || row.OrgID != tc.ws.org {
				t.Fatalf("workspace %d does not own bucket %q: %+v", tc.ws.org, tc.bucket, row)
			}
			foreign, err := mediarepo.ActiveSliceStorage(ctx, tx, tc.other, key)
			if err != nil {
				return err
			}
			if foreign != nil {
				t.Fatalf("workspace %d can read another workspace's storage", tc.ws.org)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
