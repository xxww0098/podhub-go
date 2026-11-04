package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

const (
	sliceAccountID     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	workspaceSlicePath = "/api/workspace/slice-storage"
)

func sliceTestServer() (*Server, *access.Principal) {
	p := &access.Principal{UserID: 9, OrgID: 4, WorkspaceRole: "owner", PlatformRole: "user", TokenHash: "podhub-login-a"}
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	return &Server{
		Access: access.FixedResolver{Principal: p}, Now: func() time.Time { return now },
		SliceStorageKey: []byte(strings.Repeat("k", 32)),
	}, p
}

func sliceCall(s *Server, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "https://podhub.example"+path, strings.NewReader(body))
	req.Header.Set("Origin", "https://podhub.example")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "sid", Value: "login-a"})
	rec := httptest.NewRecorder()
	identity.CSRF(HandlerFromMux(s, nil)).ServeHTTP(rec, req)
	return rec
}
