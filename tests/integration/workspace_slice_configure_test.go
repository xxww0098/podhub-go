package integration

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestWorkspaceSliceConfigureFillsAndVerifiesCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org, workspace := securityOrg(t, ctx, pool, "slice-configure")
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	seedMatchingLease(t, ctx, pool, "recipe", "workspace storage configuration")
	hxExec(t, ctx, pool, `UPDATE account_profiles SET active_org_id=$2 WHERE user_id=$1`, owner, org)
	tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace)))
	hxExec(t, ctx, pool, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($2,$1,clock_timestamp()+interval '1 hour')`, owner, tokenHash)
	principal := &access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: tokenHash}
	s := &httpapi.Server{
		Pool: pool, Access: access.FixedResolver{Principal: principal},
		SliceStorageKey: []byte(strings.Repeat("k", 32)), PublicURL: "https://podhub.example",
	}
	probes := 0
	s.VerifySlice = func(_ context.Context, account sign.Account, target, origin string) (bool, error) {
		probes++
		if target != workspace || origin != s.PublicURL {
			t.Fatalf("verification bound to another workspace: %q %q", target, origin)
		}
		if account.Endpoint != "https://"+strings.Repeat("a", 32)+".r2.cloudflarestorage.com" || account.Bucket != "team-slices" || account.AccessKeyID != "access" || account.SecretAccessKey != "secret" || account.KeyPrefix != "podhub-slices/"+account.ID+"/" {
			t.Fatalf("verification received another configuration: %+v", account)
		}
		return true, nil
	}
	handler := httpapi.HandlerFromMux(s, nil)
	call := func(method, target, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://podhub.example"+target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	const path = "/api/workspace/slice-storage"
	valid := func(change map[string]string) string {
		in := map[string]string{
			"endpoint": "https://" + strings.Repeat("a", 32) + ".r2.cloudflarestorage.com",
			"bucket":   "team-slices", "public_base_url": "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev",
			"access_key_id": "access", "secret_access_key": "secret",
		}
		for key, value := range change {
			in[key] = value
		}
		raw, _ := json.Marshal(in)
		return string(raw)
	}
	for name, body := range map[string]string{
		"http endpoint":    valid(map[string]string{"endpoint": "http://" + strings.Repeat("a", 32) + ".r2.cloudflarestorage.com"}),
		"wrong endpoint":   valid(map[string]string{"endpoint": "https://example.com"}),
		"uppercase bucket": valid(map[string]string{"bucket": "Team-slices"}),
		"public url path":  valid(map[string]string{"public_base_url": "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev/path"}),
		"missing secret":   valid(map[string]string{"secret_access_key": ""}),
	} {
		if got := call(http.MethodPost, path, body); got.Code != 400 {
			t.Fatalf("%s: %d %s", name, got.Code, got.Body.String())
		}
	}
	if probes != 0 {
		t.Fatal("invalid configuration reached the object probe")
	}
	first := call(http.MethodPost, path, valid(nil))
	if first.Code != 200 || !strings.Contains(first.Body.String(), `"configured":true`) || probes != 1 {
		t.Fatalf("configure: %d %s", first.Code, first.Body.String())
	}
	if strings.Contains(first.Body.String(), "secret") || strings.Contains(first.Body.String(), "access") {
		t.Fatal("response exposed the credential")
	}
	var active *mediarepo.SliceStorage
	err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		var err error
		active, err = mediarepo.ActiveSliceStorage(ctx, tx, org, s.SliceStorageKey)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if active == nil || active.Account.Bucket != "team-slices" || active.Account.AccessKeyID != "access" || active.Account.SecretAccessKey != "secret" {
		t.Fatalf("active configuration: %+v", active)
	}
	again := call(http.MethodPost, path, valid(map[string]string{"bucket": "another-bucket"}))
	if again.Code != 200 || !strings.Contains(again.Body.String(), `"bucket":"team-slices"`) || probes != 1 {
		t.Fatalf("configured workspace changed: %d %s", again.Code, again.Body.String())
	}
	principal.WorkspaceRole = "member"
	if got := call(http.MethodPost, path, valid(nil)); got.Code != 403 {
		t.Fatalf("member configured storage: %d %s", got.Code, got.Body.String())
	}
}

func TestWorkspaceSliceConfigureRetryAfterVerificationFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org, workspace := securityOrg(t, ctx, pool, "slice-configure-retry")
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	seedMatchingLease(t, ctx, pool, "recipe", "workspace storage configuration")
	hxExec(t, ctx, pool, `UPDATE account_profiles SET active_org_id=$2 WHERE user_id=$1`, owner, org)
	tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace)))
	hxExec(t, ctx, pool, `INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($2,$1,clock_timestamp()+interval '1 hour')`, owner, tokenHash)
	principal := &access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: tokenHash}
	s := &httpapi.Server{
		Pool: pool, Access: access.FixedResolver{Principal: principal},
		SliceStorageKey: []byte(strings.Repeat("k", 32)), PublicURL: "https://podhub.example",
	}
	probes := 0
	s.VerifySlice = func(context.Context, sign.Account, string, string) (bool, error) {
		probes++
		if probes == 1 {
			return false, errors.New("simulated readback failure")
		}
		return true, nil
	}
	body := `{"endpoint":"https://` + strings.Repeat("a", 32) + `.r2.cloudflarestorage.com","bucket":"team-slices","public_base_url":"https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev","access_key_id":"access","secret_access_key":"secret"}`
	call := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "https://podhub.example/api/workspace/slice-storage", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		httpapi.HandlerFromMux(s, nil).ServeHTTP(w, r)
		return w
	}
	if got := call(); got.Code != 400 || !strings.Contains(got.Body.String(), "R2_VERIFICATION_FAILED") {
		t.Fatalf("failed verification was activated: %d %s", got.Code, got.Body.String())
	}
	if got := call(); got.Code != 200 || probes != 2 {
		t.Fatalf("retry: %d %s", got.Code, got.Body.String())
	}
	var active *mediarepo.SliceStorage
	err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		var err error
		active, err = mediarepo.ActiveSliceStorage(ctx, tx, org, s.SliceStorageKey)
		return err
	})
	if err != nil || active == nil || active.Account.Bucket != "team-slices" {
		t.Fatalf("active after retry: %+v %v", active, err)
	}
}
