package cataloghttp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// stubActions records which action the router reached, so a route test can
// prove the wiring without a database.
type stubActions struct {
	last   string
	source string
	prod   string
	user   int64
	set    *bool
	cost   *int64
	err    error
}

func (s *stubActions) Sources(_ context.Context, userID int64) (contract.SourceListData, error) {
	s.last, s.user = "sources", userID
	return contract.SourceListData{Sources: []contract.SourceSummary{}}, s.err
}

func (s *stubActions) Detail(_ context.Context, userID int64, sourceID string) (contract.SourceDetail, error) {
	s.last, s.user, s.source = "detail", userID, sourceID
	return contract.SourceDetail{}, s.err
}

func (s *stubActions) Rows(_ context.Context, userID int64, sourceID string) (contract.RowListData, error) {
	s.last, s.user, s.source = "rows", userID, sourceID
	return contract.RowListData{}, s.err
}

func (s *stubActions) Row(_ context.Context, userID int64, sourceID, productID string) (contract.CatalogRow, error) {
	s.last, s.user, s.source, s.prod = "row", userID, sourceID, productID
	return contract.CatalogRow{}, s.err
}

func (s *stubActions) CreateRow(_ context.Context, userID int64, sourceID string, in contract.RowInput, now int64) (contract.CatalogRow, error) {
	s.last, s.user, s.source = "create", userID, sourceID
	s.cost = in.CostCents
	return contract.CatalogRow{}, s.err
}

func (s *stubActions) UpdateRow(_ context.Context, userID int64, sourceID, productID string, in contract.RowInput, now int64) (contract.CatalogRow, error) {
	s.last, s.user, s.source, s.prod = "update", userID, sourceID, productID
	return contract.CatalogRow{}, s.err
}

func (s *stubActions) SetPublished(_ context.Context, userID int64, sourceID, productID string, on bool, now int64) (contract.CatalogRow, error) {
	s.last, s.user, s.source, s.prod, s.set = "publish", userID, sourceID, productID, &on
	return contract.CatalogRow{}, s.err
}

func (s *stubActions) DeleteRow(_ context.Context, userID int64, sourceID, productID string, now int64) error {
	s.last, s.user, s.source, s.prod = "delete", userID, sourceID, productID
	return s.err
}

type stubSession struct {
	p   *Principal
	ref *Refusal
	err error
}

func (s stubSession) Resolve(*http.Request) (*Principal, *Refusal, error) {
	return s.p, s.ref, s.err
}

func newRouter(t *testing.T, actions *stubActions, sess Session) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	Mount(r, Deps{Session: sess, Actions: actions, Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }})
	return r
}

// TestSupplierCatalogRoutesMatchActions pins the method+path -> action mapping.
//
// A router that silently lost a route still compiles, and the golden route
// table only proves a path EXISTS, not that it reaches the right handler. This
// table is what catches a copy-pasted handler on the wrong verb.
func TestSupplierCatalogRoutesMatchActions(t *testing.T) {
	user := &Principal{UserID: 7, PlatformRole: "super_admin"}
	cases := []struct {
		method, path string
		want         string
		status       int
	}{
		{http.MethodGet, "/api/supplier-catalog/sources", "sources", 200},
		{http.MethodGet, "/api/supplier-catalog/sources/src1", "detail", 200},
		{http.MethodGet, "/api/supplier-catalog/sources/src1/rows", "rows", 200},
		{http.MethodGet, "/api/supplier-catalog/sources/src1/rows/p1", "row", 200},
		{http.MethodPost, "/api/supplier-catalog/sources/src1/rows", "create", 201},
		{http.MethodPut, "/api/supplier-catalog/sources/src1/rows/p1", "update", 200},
		{http.MethodDelete, "/api/supplier-catalog/sources/src1/rows/p1", "delete", 204},
		{http.MethodPost, "/api/supplier-catalog/sources/src1/rows/p1/publish", "publish", 200},
		{http.MethodPost, "/api/supplier-catalog/sources/src1/rows/p1/unpublish", "publish", 200},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			actions := &stubActions{}
			r := newRouter(t, actions, stubSession{p: user})
			body := strings.NewReader(`{"title":"t","platformCode":"c","costCents":100,"revision":1}`)
			req := httptest.NewRequest(c.method, c.path, body)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != c.status {
				t.Fatalf("status %d, want %d (body %s)", rec.Code, c.status, rec.Body.String())
			}
			if actions.last != c.want {
				t.Fatalf("reached %q, want %q", actions.last, c.want)
			}
			if actions.user != 7 {
				t.Fatalf("user id %d did not reach the action", actions.user)
			}
		})
	}
}

// TestSupplierCatalogUnpublishSendsFalse catches the classic copy-paste bug:
// /unpublish wired to the same handler literal as /publish.
func TestSupplierCatalogUnpublishSendsFalse(t *testing.T) {
	actions := &stubActions{}
	r := newRouter(t, actions, stubSession{p: &Principal{UserID: 1, PlatformRole: "super_admin"}})
	req := httptest.NewRequest(http.MethodPost, "/api/supplier-catalog/sources/s/rows/p/unpublish", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if actions.set == nil || *actions.set {
		t.Fatalf("unpublish sent on=%v, want false", actions.set)
	}
}

// TestSupplierCatalogCreateForwardsCost checks that costCents survives the JSON
// decode. It is the one input field with no output counterpart, so a rename on
// either side would silently drop the cost and the seller would see CNY 0.00.
func TestSupplierCatalogCreateForwardsCost(t *testing.T) {
	actions := &stubActions{}
	r := newRouter(t, actions, stubSession{p: &Principal{UserID: 1}})
	req := httptest.NewRequest(http.MethodPost, "/api/supplier-catalog/sources/s/rows",
		strings.NewReader(`{"title":"t","platformCode":"c","costCents":4321,"shippingCostCents":99}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 201 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if actions.cost == nil || *actions.cost != 4321 {
		t.Fatalf("costCents did not reach the action: %v", actions.cost)
	}
}

// TestSupplierCatalogRefusalsAreJSON keeps the error envelope stable for the
// frontend: every refusal is {error, code}, never a bare status.
func TestSupplierCatalogRefusalsAreJSON(t *testing.T) {
	actions := &stubActions{err: contract.Forbidden()}
	r := newRouter(t, actions, stubSession{p: &Principal{UserID: 1}})
	req := httptest.NewRequest(http.MethodGet, "/api/supplier-catalog/sources/s/rows", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("status %d, want 403", rec.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("body is not json: %v", err)
	}
	if body["code"] == "" || body["error"] == "" {
		t.Fatalf("envelope missing code/error: %v", body)
	}
}

// TestSupplierCatalogMissingKeysEnvelope pins the readiness refusal shape: the
// publish button needs the list of unmet gates, not just "not ready".
func TestSupplierCatalogMissingKeysEnvelope(t *testing.T) {
	actions := &stubActions{err: contract.ValidationMissing("未满足上架条件", []string{"prompt", "ozonConfig"})}
	r := newRouter(t, actions, stubSession{p: &Principal{UserID: 1, PlatformRole: "super_admin"}})
	req := httptest.NewRequest(http.MethodPost, "/api/supplier-catalog/sources/s/rows/p/publish", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	var body struct {
		Missing []string `json:"missing"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Missing) != 2 {
		t.Fatalf("missing=%v, want 2 keys", body.Missing)
	}
}

// TestSupplierCatalogRejectsUnknownFields refuses a body that carries a field
// the server does not know, so a client typo cannot be silently ignored.
func TestSupplierCatalogRejectsUnknownFields(t *testing.T) {
	actions := &stubActions{}
	r := newRouter(t, actions, stubSession{p: &Principal{UserID: 1}})
	req := httptest.NewRequest(http.MethodPost, "/api/supplier-catalog/sources/s/rows",
		bytes.NewReader([]byte(`{"title":"t","platformCode":"c","costCent":1}`)))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status %d, want 400 for a misspelled field", rec.Code)
	}
}

// TestSupplierCatalogNeedsSession asserts the identity seam is mandatory: a nil
// session is a 401, never a panic and never an unauthenticated 200.
func TestSupplierCatalogNeedsSession(t *testing.T) {
	actions := &stubActions{}
	r := chi.NewRouter()
	Mount(r, Deps{Actions: actions})
	req := httptest.NewRequest(http.MethodGet, "/api/supplier-catalog/sources", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

// TestSupplierCatalogSessionRefusal proves a refusal from the resolver is
// forwarded with its own status, not flattened to 401.
func TestSupplierCatalogSessionRefusal(t *testing.T) {
	actions := &stubActions{}
	r := newRouter(t, actions, stubSession{ref: &Refusal{Status: 403, Message: "无权访问"}})
	req := httptest.NewRequest(http.MethodGet, "/api/supplier-catalog/sources", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}
