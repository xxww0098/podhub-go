package storehttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

func TestRenameSetsManualAndRejectsSecrets(t *testing.T) {
	var gotName, gotRole string
	h := chi.NewRouter()
	Mount(h, Deps{
		Resolve: func(*http.Request) (*Session, *Refusal, error) {
			return &Session{UserID: 1, OrgID: 9, WorkspaceRole: "owner"}, nil, nil
		},
		Roster: stubRoster{update: func(role string, in domain.UpdateStoreInput) (domain.Row, *contract.APIError) {
			gotRole, gotName = role, *in.Name
			return domain.Row{
				UUID: "00000000-0000-4000-8000-000000000001", Name: *in.Name, Revision: 2,
			}, nil
		}},
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/workspaces/stores/00000000-0000-4000-8000-000000000001", strings.NewReader(`{"name":"handmade"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || gotRole != "owner" || gotName != "handmade" {
		t.Fatalf("%d %s role %s name %s", rec.Code, rec.Body.String(), gotRole, gotName)
	}
	if !strings.Contains(rec.Body.String(), `"name":"handmade"`) {
		t.Fatal(rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/workspaces/stores/00000000-0000-4000-8000-000000000001", strings.NewReader(`{"name":"x","apiKey":"fixture-api-key-store-autofill","inn":"tax-inn-must-not-leak"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), "fixture-api-key") || strings.Contains(rec.Body.String(), "tax-inn") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateStoreTellsAbsentFromNull pins the partial patch: an absent client_id
// leaves the stored one alone, and an explicit null is a clear. Both go through
// one body read, so a second read of r.Body silently drops the distinction.
func TestUpdateStoreTellsAbsentFromNull(t *testing.T) {
	cases := []struct {
		body      string
		wantSet   bool
		wantValue *string
		wantName  string
	}{
		{body: `{"name":"a","revision":1}`, wantSet: false, wantValue: nil, wantName: "a"},
		{body: `{"client_id":null,"revision":1}`, wantSet: true, wantValue: nil},
		{body: `{"client_id":"cid-1","revision":1}`, wantSet: true, wantValue: strPtr("cid-1")},
	}
	for _, tc := range cases {
		var seen domain.UpdateStoreInput
		h := chi.NewRouter()
		Mount(h, Deps{
			Resolve: func(*http.Request) (*Session, *Refusal, error) {
				return &Session{UserID: 1, OrgID: 9, WorkspaceRole: "owner"}, nil, nil
			},
			Roster: stubRoster{update: func(_ string, in domain.UpdateStoreInput) (domain.Row, *contract.APIError) {
				seen = in
				return domain.Row{UUID: "00000000-0000-4000-8000-000000000001", Revision: 2}, nil
			}},
		})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/workspaces/stores/00000000-0000-4000-8000-000000000001", strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", tc.body, rec.Code, rec.Body.String())
		}
		if seen.ClientIDSet != tc.wantSet {
			t.Fatalf("%s: ClientIDSet = %v, want %v", tc.body, seen.ClientIDSet, tc.wantSet)
		}
		switch {
		case tc.wantValue == nil && seen.ClientID != nil:
			t.Fatalf("%s: ClientID = %q, want nil", tc.body, *seen.ClientID)
		case tc.wantValue != nil && (seen.ClientID == nil || *seen.ClientID != *tc.wantValue):
			t.Fatalf("%s: ClientID = %v, want %q", tc.body, seen.ClientID, *tc.wantValue)
		}
	}
}

func strPtr(value string) *string { return &value }

func TestRenameForbiddenAndLoggedOut(t *testing.T) {
	h := chi.NewRouter()
	Mount(h, Deps{
		Resolve: func(*http.Request) (*Session, *Refusal, error) {
			return &Session{UserID: 1, OrgID: 9, WorkspaceRole: "member"}, nil, nil
		},
		Roster: stubRoster{update: func(string, domain.UpdateStoreInput) (domain.Row, *contract.APIError) {
			return domain.Row{}, contract.Forbidden(contract.MsgManagerOnly)
		}},
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/workspaces/stores/00000000-0000-4000-8000-000000000001", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatal(rec.Code, rec.Body.String())
	}
}

func TestRefreshRejectsSecretsAndReturnsWarning(t *testing.T) {
	h := chi.NewRouter()
	Mount(h, Deps{
		Resolve: func(*http.Request) (*Session, *Refusal, error) {
			return &Session{UserID: 1, OrgID: 9, WorkspaceRole: "owner"}, nil, nil
		},
		Actions: stubActions{refresh: func() (domain.Store, string, error) {
			return domain.Store{UUID: "00000000-0000-4000-8000-000000000001", Name: "LUAN4", Source: domain.SourceAuto, Currency: "CNY", KeyStatus: domain.KeyValid}, "公司币种 CNY 与店铺定价币种 USD 不一致", nil
		}},
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/stores/00000000-0000-4000-8000-000000000001/seller-info", strings.NewReader(`{"apiKey":"fixture-api-key-store-autofill","inn":"tax-inn-must-not-leak","tax_system":"tax-system-must-not-leak","ownership_form":"ownership-form-must-not-leak"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), "fixture-api-key") || strings.Contains(rec.Body.String(), "tax-") || strings.Contains(rec.Body.String(), "ownership") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/workspaces/stores/00000000-0000-4000-8000-000000000001/seller-info", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"currency_mismatch":true`) || !strings.Contains(rec.Body.String(), `"seller_key_status":"valid"`) || strings.Contains(rec.Body.String(), "inn") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

type stubActions struct {
	rename  func(role, name string) (domain.Store, error)
	refresh func() (domain.Store, string, error)
}

func (s stubActions) Rename(_ context.Context, _, _ int64, role, _, name string) (domain.Store, error) {
	if s.rename == nil {
		return domain.Store{}, contract.ErrNotFound
	}
	return s.rename(role, name)
}

func (s stubActions) Refresh(context.Context, int64, int64, string, string) (domain.Store, string, error) {
	if s.refresh == nil {
		return domain.Store{}, "", contract.ErrNotFound
	}
	return s.refresh()
}

// stubRoster implements RosterActions with only the method under test wired.
// Everything else answers "not found", which is what an unmounted route would
// have done.
type stubRoster struct {
	update func(role string, in domain.UpdateStoreInput) (domain.Row, *contract.APIError)
}

func (s stubRoster) Roster(context.Context, int64, int64) (domain.Roster, domain.Actor, *contract.APIError) {
	return domain.Roster{}, domain.Actor{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) CreateStore(context.Context, int64, int64, domain.CreateStoreInput) (domain.Row, domain.QuotaChanges, domain.Actor, *contract.APIError) {
	return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) UpdateStore(_ context.Context, _, _ int64, role, _ string, in domain.UpdateStoreInput) (domain.Row, domain.Actor, *contract.APIError) {
	if s.update == nil {
		return domain.Row{}, domain.Actor{}, contract.NotFound(contract.MsgStoreMissing)
	}
	row, api := s.update(role, in)
	return row, domain.Actor{UserID: 1, Role: role}, api
}

func (s stubRoster) SetStatus(context.Context, int64, int64, string, string, bool, int64) (domain.Row, domain.QuotaChanges, domain.Actor, *contract.APIError) {
	return domain.Row{}, domain.QuotaChanges{}, domain.Actor{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) DeleteStore(context.Context, int64, int64, string, int64, int64) (domain.Row, int64, domain.QuotaChanges, *contract.APIError) {
	return domain.Row{}, 0, domain.QuotaChanges{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) SetAssignee(context.Context, int64, int64, string, string, *int64, int64) (domain.Row, domain.Actor, *contract.APIError) {
	return domain.Row{}, domain.Actor{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) ConsumeTombstone(context.Context, int64, int64, string, int64) (domain.TombstoneResult, *contract.APIError) {
	return domain.TombstoneResult{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) CreateGroup(context.Context, int64, int64, string, string) (domain.TagView, *contract.APIError) {
	return domain.TagView{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) RenameGroup(context.Context, int64, int64, string, string, string) (domain.TagView, *contract.APIError) {
	return domain.TagView{}, contract.NotFound(contract.MsgStoreMissing)
}

func (s stubRoster) DeleteGroup(context.Context, int64, int64, string, string) (string, *contract.APIError) {
	return "", contract.NotFound(contract.MsgStoreMissing)
}
