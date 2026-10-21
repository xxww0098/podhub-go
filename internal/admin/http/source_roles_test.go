package adminhttp

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// roleStore records the grant calls the six source-role handlers make.
type roleStore struct {
	fakeStore
	fulfillers []domain.Fulfiller
	managers   []domain.CatalogManager
	granted    int64
	revoked    string
	grantSrc   string
}

func (s *roleStore) ListFulfillers(_ context.Context, _ contract.Actor, sourceID string) ([]domain.Fulfiller, error) {
	s.grantSrc = sourceID
	return s.fulfillers, nil
}

func (s *roleStore) GrantFulfiller(_ context.Context, _ contract.Actor, sourceID string, userID, _ int64) (domain.Fulfiller, error) {
	s.grantSrc, s.granted = sourceID, userID
	return domain.Fulfiller{FulfillerID: "f-1", SourceID: sourceID, UserID: userID, Status: "active"}, nil
}

func (s *roleStore) RevokeFulfiller(_ context.Context, _ contract.Actor, _ string, id string, _ int64) error {
	s.revoked = id
	return nil
}

func (s *roleStore) ListCatalogManagers(_ context.Context, _ contract.Actor, _ string) ([]domain.CatalogManager, error) {
	return s.managers, nil
}

func (s *roleStore) GrantCatalogManager(_ context.Context, _ contract.Actor, sourceID string, userID, _ int64) (domain.CatalogManager, error) {
	s.grantSrc, s.granted = sourceID, userID
	return domain.CatalogManager{ManagerID: "m-1", SourceID: sourceID, UserID: userID, Status: "active"}, nil
}

func (s *roleStore) RevokeCatalogManager(_ context.Context, _ contract.Actor, _ string, id string, _ int64) error {
	s.revoked = id
	return nil
}

// sourceRoleRoutes is every route this file adds for the two authorization
// tables. The staff case is the important one: these are super-admin only.
var sourceRoleRoutes = []struct{ method, path, body string }{
	{http.MethodGet, "/api/admin/supplier-dbs/src/fulfillers", ""},
	{http.MethodPost, "/api/admin/supplier-dbs/src/fulfillers", `{"userId":7}`},
	{http.MethodDelete, "/api/admin/supplier-dbs/src/fulfillers/00000000-0000-0000-0000-000000000001", ""},
	{http.MethodGet, "/api/admin/supplier-dbs/src/catalog-managers", ""},
	{http.MethodPost, "/api/admin/supplier-dbs/src/catalog-managers", `{"userId":7}`},
	{http.MethodDelete, "/api/admin/supplier-dbs/src/catalog-managers/00000000-0000-0000-0000-000000000002", ""},
}

func TestSourceRoleRoutesAreSuperOnly(t *testing.T) {
	store := &roleStore{}
	svc := service.New(store)
	staff := chi.NewRouter()
	Mount(staff, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "admin"}}), Supplier: &svc})
	for _, rt := range sourceRoleRoutes {
		rec := call(staff, rt.method, rt.path, rt.body)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "需要超级管理员权限") {
			t.Fatalf("%s %s %d %s", rt.method, rt.path, rec.Code, rec.Body.String())
		}
	}
	if store.granted != 0 || store.revoked != "" {
		t.Fatal("staff reached the store")
	}
}

func TestSourceRoleEnvelopes(t *testing.T) {
	store := &roleStore{
		fulfillers: []domain.Fulfiller{{FulfillerID: "f-1", SourceID: "src", UserID: 7, Email: "a@b.c", Name: "A", Status: "active", CreatedAtMs: 5}},
		managers:   []domain.CatalogManager{{ManagerID: "m-1", SourceID: "src", UserID: 8, Email: "d@e.f", Status: "active", CreatedAtMs: 6}},
	}
	svc := service.New(store)
	super := chi.NewRouter()
	Mount(super, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "super_admin"}}), Supplier: &svc})

	rec := call(super, http.MethodGet, "/api/admin/supplier-dbs/src/fulfillers", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"fulfillers":[{"fulfillerId":"f-1","sourceId":"src","userId":7,"email":"a@b.c","name":"A","status":"active","createdAtMs":5}]}}` {
		t.Fatalf("list fulfillers %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodGet, "/api/admin/supplier-dbs/src/catalog-managers", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"catalogManagers":[{"managerId":"m-1","sourceId":"src","userId":8,"email":"d@e.f","name":"","status":"active","createdAtMs":6}]}}` {
		t.Fatalf("list managers %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodPost, "/api/admin/supplier-dbs/src/fulfillers", `{"userId":7}`)
	if rec.Code != http.StatusCreated || rec.Body.String() != `{"data":{"fulfiller":{"fulfillerId":"f-1","sourceId":"src","userId":7,"email":"","name":"","status":"active","createdAtMs":0}}}` {
		t.Fatalf("grant fulfiller %d %s", rec.Code, rec.Body.String())
	}
	if store.grantSrc != "src" || store.granted != 7 {
		t.Fatalf("grant args %q %d", store.grantSrc, store.granted)
	}
	rec = call(super, http.MethodPost, "/api/admin/supplier-dbs/src/catalog-managers", `{"userId":8}`)
	if rec.Code != http.StatusCreated || rec.Body.String() != `{"data":{"catalogManager":{"managerId":"m-1","sourceId":"src","userId":8,"email":"","name":"","status":"active","createdAtMs":0}}}` {
		t.Fatalf("grant manager %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodDelete, "/api/admin/supplier-dbs/src/fulfillers/00000000-0000-0000-0000-000000000001", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"fulfillerId":"00000000-0000-0000-0000-000000000001","revoked":true}}` {
		t.Fatalf("revoke fulfiller %d %s", rec.Code, rec.Body.String())
	}
	if store.revoked != "00000000-0000-0000-0000-000000000001" {
		t.Fatalf("revoke id %q", store.revoked)
	}
	rec = call(super, http.MethodDelete, "/api/admin/supplier-dbs/src/catalog-managers/00000000-0000-0000-0000-000000000002", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"managerId":"00000000-0000-0000-0000-000000000002","revoked":true}}` {
		t.Fatalf("revoke manager %d %s", rec.Code, rec.Body.String())
	}
}

func TestSourceRoleBodies(t *testing.T) {
	svc := service.New(&roleStore{})
	super := chi.NewRouter()
	Mount(super, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "super_admin"}}), Supplier: &svc})
	for _, body := range []string{`{}`, `{"userId":0}`, `{"userId":-1}`, `{"userId":"7"}`, `{"userId":7,"extra":1}`, `null`} {
		rec := call(super, http.MethodPost, "/api/admin/supplier-dbs/src/fulfillers", body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"VALIDATION"`) {
			t.Fatalf("%s -> %d %s", body, rec.Code, rec.Body.String())
		}
	}
	rec := call(super, http.MethodDelete, "/api/admin/supplier-dbs/src/fulfillers/not-a-uuid", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "履约授权不存在") {
		t.Fatalf("bad uuid %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodDelete, "/api/admin/supplier-dbs/src/catalog-managers/not-a-uuid", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "商品负责人授权不存在") {
		t.Fatalf("bad uuid %d %s", rec.Code, rec.Body.String())
	}
}
