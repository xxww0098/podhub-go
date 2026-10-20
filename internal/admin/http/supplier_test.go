package adminhttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/identity"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestSupplierListBytesAndHeaders(t *testing.T) {
	name := "厂长"
	db := domain.SupplierDb{
		SourceID: "src_1", Name: "广州印花厂", Country: "CN", Contact: "ops@factory.invalid",
		InternalNote: "旺季", Listed: true, Icon: "🏭", AcceptsDelegate: false,
		ViewPrefs: json.RawMessage(`{"kanban":"status"}`), RowCount: 0, PublishedCount: 0,
		CreatedAtMs: 10, UpdatedAtMs: 10, CreatedBy: "pub", CreatorName: &name,
	}
	svc := service.New(fakeStore{dbs: []domain.SupplierDb{db}})
	h := chi.NewRouter()
	Mount(h, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 0, PlatformRole: "admin"}}), Supplier: &svc})
	rec := call(h, http.MethodGet, "/api/admin/supplier-dbs", "")
	const want = `{"data":{"dbs":[{"sourceId":"src_1","name":"广州印花厂","country":"CN","contact":"ops@factory.invalid","internalNote":"旺季","listed":true,"icon":"🏭","acceptsDelegate":false,"viewPrefs":{"kanban":"status"},"rowCount":0,"publishedCount":0,"createdAtMs":10,"updatedAtMs":10,"createdBy":"pub","creatorName":"厂长"}]}}`
	if rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "private, no-store" || rec.Header().Get("Vary") != "Cookie, Authorization" {
		t.Fatalf("headers %v", rec.Header())
	}
	if rec.Header().Get("X-Content-Type-Options") != "" {
		t.Fatal("success nosniff")
	}
	rec = call(h, http.MethodGet, "/api/admin/supplier-accounts", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"groups":[]}}` {
		t.Fatalf("accounts %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "" {
		t.Fatalf("accounts cache %q", rec.Header().Get("Cache-Control"))
	}
}

func TestSupplierValidationAndAuthBytes(t *testing.T) {
	svc := service.New(fakeStore{})
	staff := chi.NewRouter()
	Mount(staff, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "admin"}}), Supplier: &svc})
	super := chi.NewRouter()
	Mount(super, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "super_admin"}}), Supplier: &svc})
	user := chi.NewRouter()
	Mount(user, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "user"}}), Supplier: &svc})

	rec := call(staff, http.MethodPost, "/api/admin/supplier-dbs", `{"name":"A","country":"","contact":"","internalNote":"","listed":false,"icon":"","template":"nope","viewPrefs":{}}`)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"未知的建库模板","code":"VALIDATION"}` {
		t.Fatalf("template %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("err headers %v", rec.Header())
	}
	rec = call(staff, http.MethodPost, "/api/admin/supplier-dbs/src/props", `{"name":"面料","type":"text","sellerVisible":true,"options":[]}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"VALIDATION"`) {
		t.Fatalf("position %d %s", rec.Code, rec.Body.String())
	}
	rec = call(user, http.MethodGet, "/api/admin/supplier-dbs", "")
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"error":"需要平台管理员权限","code":"FORBIDDEN"}` {
		t.Fatalf("staff gate %d %s", rec.Code, rec.Body.String())
	}
	anon := chi.NewRouter()
	Mount(anon, Deps{Supplier: &svc})
	rec = call(anon, http.MethodPatch, "/api/admin/supplier-accounts/00000000-0000-0000-0000-000000000001", `{}`)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"没有要修改的内容","code":"validation"}` {
		t.Fatalf("empty patch %d %s", rec.Code, rec.Body.String())
	}
	rec = call(staff, http.MethodPatch, "/api/admin/supplier-accounts/00000000-0000-0000-0000-000000000001", `{"password":"brand new passphrase"}`)
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"error":"需要超级管理员权限","code":"forbidden"}` {
		t.Fatalf("password gate %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodGet, "/api/admin/supplier-withdrawals?status=nope", "")
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"提现状态无效","code":"validation"}` {
		t.Fatalf("withdrawal %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodGet, "/api/admin/supplier-withdrawals", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"withdrawals":[]}}` {
		t.Fatalf("withdrawal list %d %s", rec.Code, rec.Body.String())
	}
	rec = call(super, http.MethodGet, "/api/admin/supplier-prompts", "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"prompts":[]}}` || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("prompts %d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}
	rec = call(super, http.MethodGet, "/api/admin/supplier-db-storage/objects", "")
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"error":"先配置平台货源存储桶","code":"STORAGE_NOT_CONFIGURED"}` {
		t.Fatalf("storage %d %s", rec.Code, rec.Body.String())
	}
	anonPay := chi.NewRouter()
	Mount(anonPay, Deps{Supplier: &svc})
	rec = call(anonPay, http.MethodPost, "/api/admin/supplier-withdrawals/not-uuid/pay", `{`)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"请求格式无效","code":"validation"}` {
		t.Fatalf("pay json %d %s", rec.Code, rec.Body.String())
	}
	rec = call(staff, http.MethodGet, "/api/admin/supplier-automation/grants", "")
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "登录已失效") {
		t.Fatalf("grant %d %s", rec.Code, rec.Body.String())
	}
}

func TestCSRFStillRejectsCookieWrite(t *testing.T) {
	h := chi.NewRouter()
	h.Use(identity.CSRF)
	Mount(h, Deps{})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/supplier-dbs", strings.NewReader(`{}`))
	req.Header.Set("Cookie", "sid=abc")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"code":"csrf_rejected","message":"跨站请求已被拒绝"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "" {
		t.Fatal("csrf is outside the private catalog layer")
	}
}

type fakeStore struct {
	dbs []domain.SupplierDb
}

func (f fakeStore) ListDbs(context.Context, contract.Actor) ([]domain.SupplierDb, error) {
	if f.dbs == nil {
		return []domain.SupplierDb{}, nil
	}
	return f.dbs, nil
}
func (f fakeStore) CreateDb(context.Context, contract.Actor, domain.NormalizedDb, string, []domain.PropSeed, int64, string) (domain.SupplierDb, *string, error) {
	return domain.SupplierDb{}, nil, nil
}
func (f fakeStore) UpdateDb(context.Context, contract.Actor, string, domain.NormalizedDb, int64, string) (domain.SupplierDb, *string, error) {
	return domain.SupplierDb{}, nil, nil
}
func (f fakeStore) DeleteDb(context.Context, contract.Actor, string) error { return nil }
func (f fakeStore) CreateProp(context.Context, contract.Actor, string, string, domain.NormalizedProp, int64) (domain.Prop, error) {
	return domain.Prop{}, nil
}
func (f fakeStore) UpdateProp(context.Context, contract.Actor, string, string, domain.NormalizedProp, int64) (domain.Prop, error) {
	return domain.Prop{}, nil
}
func (f fakeStore) DeleteProp(context.Context, contract.Actor, string, string) (int64, error) {
	return 0, nil
}
func (f fakeStore) DeleteRow(context.Context, contract.Actor, string, string, int64) error {
	return nil
}
func (f fakeStore) ListAccounts(context.Context, contract.Actor) ([]domain.Member, error) {
	return nil, nil
}
func (f fakeStore) CreateAccount(context.Context, contract.Actor, domain.NormalizedAccount, string, int64, string) (domain.Member, *string, error) {
	return domain.Member{}, nil, nil
}
func (f fakeStore) PatchAccount(context.Context, contract.Actor, string, domain.AccountPatch, string) (domain.Member, *string, error) {
	return domain.Member{}, nil, nil
}
func (f fakeStore) DeleteAccount(context.Context, contract.Actor, string) error { return nil }
func (f fakeStore) AccountStaff(context.Context, int64) (bool, bool, error) {
	return false, false, nil
}
func (f fakeStore) ListPrompts(context.Context, contract.Actor) ([]domain.Prompt, error) {
	return nil, nil
}
func (f fakeStore) ListWithdrawals(context.Context, contract.Actor, string) ([]domain.Withdrawal, error) {
	return nil, nil
}
func (f fakeStore) PayWithdrawal(context.Context, contract.Actor, string, string, int64) (domain.Withdrawal, error) {
	return domain.Withdrawal{}, nil
}
func (f fakeStore) RejectWithdrawal(context.Context, contract.Actor, string, string, int64) (domain.Withdrawal, error) {
	return domain.Withdrawal{}, nil
}
func (f fakeStore) ListGrants(context.Context, contract.Actor) ([]domain.GrantView, error) {
	return nil, nil
}
func (f fakeStore) CreateGrant(context.Context, contract.Actor, domain.GrantInput) (domain.GrantView, string, error) {
	return domain.GrantView{}, "", nil
}
func (f fakeStore) RevokeGrant(context.Context, contract.Actor, string) (string, error) {
	return "", nil
}
