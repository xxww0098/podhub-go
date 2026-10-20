package telemetryhttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

func TestEventInboxAuthAndValidation(t *testing.T) {
	if len(Routes()) != 2 {
		t.Fatal(Routes())
	}
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(&access.Principal{UserID: 1, OrgID: 3, WorkspaceRole: "member"}), Actions: rejectStore{}})

	rec := post(r, "/api/events/inbox", "", `{"events":[]}`)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"AUTH_REQUIRED"`) || !strings.Contains(rec.Body.String(), "X-Podhub-Device-Id") {
		t.Fatalf("device %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff")
	}

	req := httptest.NewRequest(http.MethodPost, "/api/events/inbox", strings.NewReader(`{"events":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Podhub-Device-Id", "dev-1")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":[]`) || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("empty %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/events/inbox", strings.NewReader(`[]`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Podhub-Device-Id", "dev-1")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "请求格式无效") {
		t.Fatalf("json %d %s", rec.Code, rec.Body.String())
	}

	loggedOut := chi.NewRouter()
	Mount(loggedOut, Deps{})
	rec = post(loggedOut, "/api/events/inbox", "dev", `{"events":[]}`)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"AUTH_REQUIRED"`) || !strings.Contains(rec.Body.String(), "未登录") {
		t.Fatalf("auth %d %s", rec.Code, rec.Body.String())
	}
}

func TestClientLogsSwitchBeforeAuth(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Collect: false})
	rec := post(r, "/api/listing/client-logs", "", `{"records":[]}`)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "客户端日志采集未开启") {
		t.Fatalf("off %d %s", rec.Code, rec.Body.String())
	}

	on := chi.NewRouter()
	Mount(on, Deps{Collect: true, Resolve: fixed(&access.Principal{UserID: 7, OrgID: 3, WorkspaceRole: "viewer"}), Actions: rejectStore{}, Now: func() time.Time {
		return time.Date(2026, 10, 9, 3, 0, 1, 0, time.UTC)
	}})
	body := `{"records":[{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","ts":"2026-10-09T03:00:00Z","level":"info","module":"upload","event":"upload.end","sessionId":"11111111-2222-4333-8444-555555555555","version":"0.0.99"}]}`
	rec = post(on, "/api/listing/client-logs", "", body)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":1`) || !strings.Contains(rec.Body.String(), `"dropped":0`) {
		t.Fatalf("on %d %s", rec.Code, rec.Body.String())
	}
	rec = post(on, "/api/listing/client-logs", "", `{"records":[]}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "单批需要 1 到 40 条日志") {
		t.Fatalf("count %d %s", rec.Code, rec.Body.String())
	}
}

func TestInboxDoesNotConsultOzonSwitch(t *testing.T) {
	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(&access.Principal{UserID: 1, OrgID: 3, WorkspaceRole: "owner"}), Actions: rejectStore{}})
	rec := post(r, "/api/events/inbox", "dev", `{"events":[]}`)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "WRITES_DISABLED") || strings.Contains(rec.Body.String(), "OZON") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

type rejectStore struct{}

func (rejectStore) Ingest(context.Context, domain.Ingest) (domain.IngestResult, error) {
	return domain.IngestResult{Accepted: []string{}, Rejected: []domain.RejectedEvent{}}, nil
}

func (rejectStore) InsertClientLogs(context.Context, int64, int64, []domain.ClientLog) error {
	return nil
}

func fixed(p *access.Principal) Resolve {
	return func(*http.Request) (*Session, *Refusal, error) {
		return &Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole}, nil, nil
	}
}

func post(r http.Handler, path, device, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if device != "" {
		req.Header.Set("X-Podhub-Device-Id", device)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}
