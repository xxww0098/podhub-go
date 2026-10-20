package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const (
	mediaWorkspace = "550e8400-e29b-41d4-a716-446655440000"
	mediaDigest    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

func TestMediaPresignRequiresSessionAndLoopback(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	account := sign.Account{
		ID: "acct", Provider: sign.ProviderGeneric,
		Endpoint: "http://127.0.0.1:9000", Region: "auto", Bucket: "podhub-slices",
		ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test",
		PublicBaseURL: "http://127.0.0.1:9000/podhub-slices",
	}
	var seenOrg int64
	srv := &Server{
		Access: access.FixedResolver{Principal: &access.Principal{
			UserID: 9, OrgID: 4, WorkspaceRole: "member", PlatformRole: "user",
		}},
		Now:   func() time.Time { return now },
		Media: &account,
		Workspace: func(_ context.Context, orgID int64) (string, error) {
			seenOrg = orgID
			return mediaWorkspace, nil
		},
	}
	body := `{"byte_length":12}`
	rec := mediaPost(t, srv, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.Bytes())
	}
	if seenOrg != 4 {
		t.Fatalf("workspace lookup org %d", seenOrg)
	}
	raw := rec.Body.String()
	wantKey := "images/teams/" + mediaWorkspace + "/sha256/" + mediaDigest + ".jpg"
	if !strings.Contains(raw, wantKey) || strings.Contains(raw, "example.r2.cloudflarestorage.com") {
		t.Fatalf("body %s", raw)
	}

	loggedOut := &Server{Access: access.FixedResolver{}, Media: &account, Now: srv.Now, Workspace: srv.Workspace}
	rec = mediaPost(t, loggedOut, body)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "未登录") {
		t.Fatalf("logged out %d %s", rec.Code, rec.Body.Bytes())
	}

	noOrg := &Server{
		Access: access.FixedResolver{Principal: &access.Principal{UserID: 9, WorkspaceRole: "member"}},
		Media:  &account, Now: srv.Now, Workspace: srv.Workspace,
	}
	rec = mediaPost(t, noOrg, body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no org %d %s", rec.Code, rec.Body.Bytes())
	}

	real := account
	real.Endpoint = "https://example.r2.cloudflarestorage.com"
	refused := &Server{Access: srv.Access, Media: &real, Now: srv.Now, Workspace: srv.Workspace}
	rec = mediaPost(t, refused, body)
	if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "example.r2.cloudflarestorage.com") {
		t.Fatalf("real bucket %d %s", rec.Code, rec.Body.Bytes())
	}
}

func TestMediaPresignSitsBehindAdmission(t *testing.T) {
	path := "/api/media/objects/" + mediaDigest + "/jpg/presign"
	if identity.Classify(path, http.MethodPost) != identity.ClassControl {
		t.Fatal("presign must use the control admission class")
	}
	svc := identity.New(nil)
	router := chi.NewRouter()
	router.Use(identity.CSRF)
	router.Use(svc.Middleware)
	handler := HandlerFromMux(&Server{}, router)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"byte_length":12}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing session %d %s", rec.Code, rec.Body.Bytes())
	}
}

func mediaPost(t *testing.T, srv *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/media/objects/"+mediaDigest+"/jpg/presign", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.PostMediaObjectPresign(rec, req, mediaDigest, "jpg")
	return rec
}
