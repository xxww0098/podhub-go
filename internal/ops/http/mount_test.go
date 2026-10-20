package opshttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/ops/service"
)

func fixed(p *access.Principal) Resolve {
	return func(*http.Request) (*Session, *Refusal, error) {
		if p == nil {
			return nil, nil, nil
		}
		return &Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole}, nil, nil
	}
}

func TestOpsRoutesMatchInventoryCount(t *testing.T) {
	if len(Routes()) != 18 {
		t.Fatalf("routes %d", len(Routes()))
	}
	seen := map[string]struct{}{}
	for _, rt := range Routes() {
		key := rt.Method + " " + rt.Path
		if _, ok := seen[key]; ok {
			t.Fatal(key)
		}
		seen[key] = struct{}{}
		if rt.Guard != GuardWorkspace && rt.Guard != GuardWrite {
			t.Fatal(rt)
		}
	}
}

func TestOpsUnauthenticatedAndWorkspace(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Screen: &service.Screen{}})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ops/console/snapshot", nil))
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"auth_required"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	r = chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(&access.Principal{UserID: 1}), Screen: &service.Screen{}})
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ops/console/snapshot", nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), msgNoWorkspace) || !strings.Contains(rec.Body.String(), `"code":"forbidden"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestOpsMalformedJSONStaysNotPorted(t *testing.T) {
	member := fixed(&access.Principal{UserID: 1, OrgID: 9, WorkspaceRole: "member"})
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: member, Screen: &service.Screen{}})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ops/products/mutate", strings.NewReader(`{}`)))
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"code":"not_ported"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestOpsWriteSwitchBeforeLedger(t *testing.T) {
	member := fixed(&access.Principal{UserID: 1, OrgID: 9, WorkspaceRole: "member"})
	var began int
	screen := &service.Screen{
		Stores: admitOK{},
		Ledger: ledgerCount{n: &began},
		Seller: closedSeller{},
	}
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: member, Screen: screen})
	rec := httptest.NewRecorder()
	body := `{"operation_id":"00000000-0000-4000-8000-000000000001","store_id":"00000000-0000-4000-8000-0000000000a1","request":{"kind":"stock","items":[{"product_id":41,"offer_id":"ART-41","sku":90041,"warehouse_id":7,"stock":5}]}}`
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ops/products/mutate", strings.NewReader(body)))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"code":"writes_disabled"`) || began != 0 {
		t.Fatalf("%d began %d %s", rec.Code, began, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), contract.WritesDisabledMessage) {
		t.Fatal(rec.Body.String())
	}
}

type admitOK struct{}

func (admitOK) Admit(context.Context, int64, int64, string, string, int64) (contract.Admitted, error) {
	return contract.Admitted{StorePK: 1, UUID: "00000000-0000-4000-8000-0000000000a1"}, nil
}

type ledgerCount struct{ n *int }

func (l ledgerCount) Begin(context.Context, int64, int64, string, string, string, []byte) (contract.LedgerRow, error) {
	*l.n++
	return contract.LedgerRow{}, nil
}
func (ledgerCount) Settle(context.Context, int64, int64, string, string, int, []byte) error {
	return nil
}
func (ledgerCount) MarkUnknown(context.Context, int64, int64, string, string, string, string, int) error {
	return nil
}
func (ledgerCount) Heartbeat(context.Context, int64, int64, string) error { return nil }

type closedSeller struct{}

func (closedSeller) Call(context.Context, contract.Lane, string, string, []byte, contract.Secret) (int, string, error) {
	return 0, "", contract.ErrWritesDisabled
}
func (closedSeller) WritesDisabled() bool { return true }

const stockBody = `{"operation_id":"00000000-0000-4000-8000-000000000001","store_id":"00000000-0000-4000-8000-0000000000a1","request":{"kind":"stock","items":[{"product_id":41,"offer_id":"ART-41","sku":90041,"warehouse_id":7,"stock":5}]}}`

func TestOpsWeakRolesStopBeforeAdmit(t *testing.T) {
	var admits, calls int
	screen := &service.Screen{Stores: tallyAdmit{n: &admits}, Seller: tallySeller{n: &calls}, Ledger: ledgerCount{n: new(int)}}
	for _, role := range []string{"viewer", "reviewer"} {
		admits, calls = 0, 0
		rec := serve(role, screen, http.MethodPost, "/api/ops/products/mutate", stockBody)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), contract.MsgNoWriteRole) || admits != 0 || calls != 0 {
			t.Fatalf("%s %d admits %d calls %d %s", role, rec.Code, admits, calls, rec.Body.String())
		}
	}
	admits, calls = 0, 0
	rec := serve("viewer", screen, http.MethodPost, "/api/ops/console/reconcile", "")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), contract.MsgNoReconcileRole) || admits != 0 || calls != 0 {
		t.Fatalf("reconcile %d admits %d %s", rec.Code, admits, rec.Body.String())
	}
}

func TestOpsParsedRolesCanRead(t *testing.T) {
	var admits, calls int
	screen := &service.Screen{Stores: tallyAdmit{n: &admits}, Seller: tallySeller{n: &calls}}
	for _, role := range []string{"member", "reviewer", "viewer", "owner", "manager"} {
		admits, calls = 0, 0
		rec := serve(role, screen, http.MethodPost, "/api/ops/shipping/list", `{"store_id":"00000000-0000-4000-8000-0000000000a1"}`)
		if rec.Code != http.StatusOK || admits != 1 || calls != 1 || !strings.Contains(rec.Body.String(), `"postings":[]`) {
			t.Fatalf("%s %d admits %d calls %d %s", role, rec.Code, admits, calls, rec.Body.String())
		}
	}
}

func TestOpsInvisibleStoreDoesNotCallOzon(t *testing.T) {
	var admits, calls, began int
	screen := &service.Screen{
		Stores: tallyAdmit{n: &admits, fail: &contract.Fail{Status: http.StatusNotFound, Code: contract.CodeNotFound, Message: contract.MsgStoreMissing}},
		Seller: tallySeller{n: &calls},
		Ledger: ledgerCount{n: &began},
	}
	rec := serve("member", screen, http.MethodPost, "/api/ops/products/mutate", stockBody)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), contract.MsgStoreMissing) || admits != 1 || calls != 0 || began != 0 {
		t.Fatalf("%d admits %d calls %d began %d %s", rec.Code, admits, calls, began, rec.Body.String())
	}
}

func TestOpsEmptyPromotionsSkipAuth(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ops/products/promotions", strings.NewReader(`{"store_id":"x","product_ids":[0,-3]}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"actions":[]`) || !strings.Contains(rec.Body.String(), `"offers":[]`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ops/products/promotions", strings.NewReader(`{"store_id":"x","product_ids":[4]}`)))
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"auth_required"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func serve(role string, screen *service.Screen, method, path, body string) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(&access.Principal{UserID: 1, OrgID: 9, WorkspaceRole: role}), Screen: screen})
	rec := httptest.NewRecorder()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	r.ServeHTTP(rec, httptest.NewRequest(method, path, reader))
	return rec
}

type tallyAdmit struct {
	n    *int
	fail error
}

func (a tallyAdmit) Admit(context.Context, int64, int64, string, string, int64) (contract.Admitted, error) {
	if a.n != nil {
		*a.n++
	}
	if a.fail != nil {
		return contract.Admitted{}, a.fail
	}
	return contract.Admitted{StorePK: 1, UUID: "00000000-0000-4000-8000-0000000000a1"}, nil
}

type tallySeller struct{ n *int }

func (s tallySeller) Call(context.Context, contract.Lane, string, string, []byte, contract.Secret) (int, string, error) {
	if s.n != nil {
		*s.n++
	}
	return http.StatusOK, `{"postings":[],"has_next":false,"cursor":""}`, nil
}

func (tallySeller) WritesDisabled() bool { return false }
