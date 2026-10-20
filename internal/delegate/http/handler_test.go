package delegatehttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/service"
	"github.com/xxww0098/podhub-go/tests/parity"
)

type fixedSession struct {
	userID int64
	orgID  int64
	role   string
	fail   error
	refuse *Refusal
}

func (f fixedSession) Resolve(*http.Request) (*Principal, *Refusal, error) {
	if f.fail != nil || f.refuse != nil {
		return nil, f.refuse, f.fail
	}
	return &Principal{UserID: f.userID, OrgID: f.orgID, WorkspaceRole: f.role}, nil, nil
}

type spy struct{ called bool }

func (s *spy) Accept(context.Context, int64, int64, string) (string, error) {
	s.called = true
	return "", nil
}
func (s *spy) Reject(context.Context, int64, int64, string, string) (string, error) {
	s.called = true
	return "", nil
}
func (s *spy) Ship(context.Context, int64, int64, string, string, string, int64) (string, error) {
	s.called = true
	return "", nil
}
func (s *spy) ListDispatches(context.Context, int64, int64) ([]contract.DispatchView, error) {
	s.called = true
	return nil, nil
}
func (s *spy) Presign(context.Context) error { s.called = true; return nil }
func (s *spy) Proxy(context.Context) error   { s.called = true; return nil }

type fatalTrip struct{ t *testing.T }

func (f fatalTrip) RoundTrip(*http.Request) (*http.Response, error) {
	f.t.Fatal("dialed")
	return nil, nil
}

type fakeSeller struct {
	called    string
	canManage bool
	window    int64
	limit     int64
	checksum  bool
	offersSet bool
	key       string
	err       error
}

func (f *fakeSeller) Sources(_ context.Context, actor service.Actor) ([]contract.Source, error) {
	f.called, f.canManage = "sources", actor.CanManage
	if f.err != nil {
		return nil, f.err
	}
	return []contract.Source{{SourceID: "src", Name: "厂", Country: "CN", Icon: "i"}}, nil
}
func (f *fakeSeller) Bindings(context.Context, service.Actor, string) ([]contract.Binding, error) {
	f.called = "bindings"
	return []contract.Binding{}, f.err
}
func (f *fakeSeller) CreateBinding(context.Context, service.Actor, string, string, string, string) (contract.Binding, error) {
	f.called = "create-binding"
	return contract.Binding{BindingID: "b", Assets: []contract.Asset{}}, f.err
}
func (f *fakeSeller) PatchBinding(context.Context, service.Actor, string, int64, *string, *string, *bool) (contract.Binding, error) {
	f.called = "patch"
	return contract.Binding{Assets: []contract.Asset{}}, f.err
}
func (f *fakeSeller) DeleteBinding(context.Context, service.Actor, string) error {
	f.called = "delete-binding"
	return f.err
}
func (f *fakeSeller) Presign(_ context.Context, _ service.Actor, _, _, _, _ string, _ int64, checksum bool) (contract.UploadTarget, error) {
	f.called, f.checksum = "presign", checksum
	if f.err != nil {
		return contract.UploadTarget{}, f.err
	}
	return contract.UploadTarget{ObjectKey: "k", UploadTicket: "t", Upload: contract.UploadGrant{URL: "http://127.0.0.1/u", Headers: contract.UploadHeaders{ContentType: "image/png", IfNoneMatch: "*"}, ExpiresAtMS: 1}}, nil
}
func (f *fakeSeller) Finalize(context.Context, service.Actor, string, string, string, int32) (contract.Asset, error) {
	f.called = "finalize"
	return contract.Asset{AssetID: "a", Verified: true}, f.err
}
func (f *fakeSeller) DeleteAsset(context.Context, service.Actor, string) (string, bool, error) {
	f.called = "delete-asset"
	return "a", true, f.err
}
func (f *fakeSeller) Orders(context.Context, service.Actor, string, string, string, *int64) ([]contract.Order, bool, string, error) {
	f.called = "orders"
	return []contract.Order{}, false, "", f.err
}
func (f *fakeSeller) Order(context.Context, service.Actor, string) (contract.Order, error) {
	f.called = "order"
	return contract.Order{OrderID: "o", Lines: []contract.OrderLine{}}, f.err
}
func (f *fakeSeller) CreateOrder(_ context.Context, _ service.Actor, _, _, _, key string, _ []string, set bool) (contract.Order, error) {
	f.called, f.key, f.offersSet = "create-order", key, set
	return contract.Order{Lines: []contract.OrderLine{}}, f.err
}
func (f *fakeSeller) Postings(_ context.Context, _ service.Actor, _ string, window, limit int64, _ string) (string, []contract.PostingView, bool, string, error) {
	f.called, f.window, f.limit = "postings", window, limit
	return "store", []contract.PostingView{}, false, "", f.err
}
func (f *fakeSeller) PostingStates(context.Context, service.Actor, string, string) (string, []contract.PostingStateView, error) {
	f.called = "states"
	return "store", []contract.PostingStateView{}, f.err
}
func (f *fakeSeller) Cancel(context.Context, service.Actor, string) (contract.Order, error) {
	f.called = "cancel"
	return contract.Order{Lines: []contract.OrderLine{}}, f.err
}
func (f *fakeSeller) Close(context.Context, service.Actor, string) (contract.Order, error) {
	f.called = "close"
	return contract.Order{Lines: []contract.OrderLine{}}, f.err
}
func (f *fakeSeller) Nudge(context.Context, service.Actor, string) (contract.Order, error) {
	f.called = "nudge"
	return contract.Order{Lines: []contract.OrderLine{}}, f.err
}

func mountOwner(t *testing.T, seller SellerAPI, actions Actions) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	Mount(r, Deps{
		Session:  fixedSession{userID: 7, orgID: 3, role: "owner"},
		Actions:  actions,
		Seller:   seller,
		Outbound: fatalTrip{t},
	})
	return r
}

func TestUpstreamLeftThisRouter(t *testing.T) {
	actions := &spy{}
	seller := &fakeSeller{}
	r := mountOwner(t, seller, actions)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/seller/upstream/11111111-1111-4111-8111-111111111111/ping", strings.NewReader(`{"x":1}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("upstream %d %s", rec.Code, rec.Body.Bytes())
	}
	if actions.called || seller.called != "" {
		t.Fatal("upstream called a service")
	}

	member := chi.NewRouter()
	Mount(member, Deps{Session: fixedSession{userID: 9}, Actions: actions, Seller: seller})
	rec = httptest.NewRecorder()
	member.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/seller/upstream/11111111-1111-4111-8111-111111111111/ping", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("upstream left this router %d %s", rec.Code, rec.Body.Bytes())
	}
	rec = httptest.NewRecorder()
	member.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/orders", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("orders %d %s", rec.Code, rec.Body.Bytes())
	}
}

func TestAuthSnakeCase(t *testing.T) {
	anon := chi.NewRouter()
	Mount(anon, Deps{})
	rec := httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/sources", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusUnauthorized,
		Body:   []byte(`{"error":"未登录","code":"auth_invalid"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(rec.Header().Get("X-Content-Type-Options"))
	}

	member := chi.NewRouter()
	Mount(member, Deps{Session: fixedSession{userID: 9}, Seller: &fakeSeller{}})
	rec = httptest.NewRecorder()
	member.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/orders", nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"code":"forbidden"`) {
		t.Fatalf("orders %d %s", rec.Code, rec.Body.Bytes())
	}

	bad := chi.NewRouter()
	Mount(bad, Deps{Session: fixedSession{userID: 9, orgID: 3, role: "root"}, Seller: &fakeSeller{}})
	rec = httptest.NewRecorder()
	bad.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/sources", nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "工作空间角色无效") {
		t.Fatalf("role %d %s", rec.Code, rec.Body.Bytes())
	}

	other := chi.NewRouter()
	Mount(other, Deps{Session: fixedSession{refuse: &Refusal{Status: http.StatusTeapot, Message: "no"}}, Seller: &fakeSeller{}})
	rec = httptest.NewRecorder()
	other.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/sources", nil))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal"`) {
		t.Fatalf("refusal %d %s", rec.Code, rec.Body.Bytes())
	}
}

func TestQueryRejectionPlainText(t *testing.T) {
	seller := &fakeSeller{}
	r := mountOwner(t, seller, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/bindings", nil))
	if rec.Code != http.StatusBadRequest || rec.Body.String() != "Failed to deserialize query string: missing field `storeId`" {
		t.Fatalf("bindings %d %q %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.Bytes())
	}
	if seller.called != "" {
		t.Fatal("query rejection called the seller")
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/posting-states?storeId=s", nil))
	if rec.Body.String() != "Failed to deserialize query string: missing field `postingNumbers`" {
		t.Fatalf("states %s", rec.Body.Bytes())
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/orders?limit=abc", nil))
	if rec.Code != http.StatusBadRequest || rec.Body.String() != "Failed to deserialize query string: invalid digit found in string" {
		t.Fatalf("limit %d %s", rec.Code, rec.Body.Bytes())
	}
}

func TestStrictJSONAndIdempotency(t *testing.T) {
	seller := &fakeSeller{}
	r := mountOwner(t, seller, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/seller/delegate/orders", strings.NewReader(`{"storeId":"s"`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"请求格式无效","code":"validation"}` {
		t.Fatalf("json %d %s", rec.Code, rec.Body.Bytes())
	}
	if seller.called != "" {
		t.Fatal("bad json reached the seller")
	}

	req = httptest.NewRequest(http.MethodPost, "/api/seller/delegate/orders", strings.NewReader(`{"storeId":"s","postingNumber":"p"}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Body.String() != `{"error":"缺少 Idempotency-Key 头","code":"validation"}` {
		t.Fatalf("key %s", rec.Body.Bytes())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/seller/delegate/orders", strings.NewReader(`{"storeId":"s","postingNumber":"p","offerIds":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "abc")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if seller.called != "create-order" || seller.key != "abc" || !seller.offersSet {
		t.Fatalf("create %+v", seller)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/seller/delegate/postings", strings.NewReader(`{"storeId":"s"}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if seller.window != 30 || seller.limit != 50 {
		t.Fatalf("defaults %d %d", seller.window, seller.limit)
	}
}

func TestPresignCacheControl(t *testing.T) {
	seller := &fakeSeller{err: contract.NotFound("绑定不存在")}
	r := mountOwner(t, seller, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/seller/delegate/assets/presign", strings.NewReader(`{"no":1}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Header().Get("Cache-Control") != "private, no-store" || !strings.Contains(rec.Body.String(), "请求格式无效") {
		t.Fatalf("bad %s %s", rec.Header().Get("Cache-Control"), rec.Body.Bytes())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/seller/delegate/assets/presign", strings.NewReader(`{"bindingId":"b","sha256":"ab","bytes":1,"mime":"image/png","fileName":"a.png"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-podhub-store-checksum", "ab")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("miss %d %s", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if !seller.checksum {
		t.Fatal("checksum header was dropped")
	}

	seller.err = nil
	req = httptest.NewRequest(http.MethodPost, "/api/seller/delegate/assets/presign", strings.NewReader(`{"bindingId":"b","sha256":"ab","bytes":1,"mime":"image/png","fileName":"a.png"}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "private, no-store" || !strings.Contains(rec.Body.String(), `"objectKey":"k"`) {
		t.Fatalf("ok %d %s %s", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.Bytes())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/seller/delegate/assets", strings.NewReader(`{"bindingId":"b","uploadTicket":"t","fileName":"a.png"}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "" || !strings.Contains(rec.Body.String(), `"assetId":"a"`) {
		t.Fatalf("finalize %d %q %s", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.Bytes())
	}
}

func TestAssetRouteErrorBytes(t *testing.T) {
	presign := `{"bindingId":"b","sha256":"ab","bytes":1,"mime":"image/png","fileName":"a.png"}`
	finalize := `{"bindingId":"b","uploadTicket":"t","fileName":"a.png"}`
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		err    error
		status int
		want   string
		cache  string
	}{
		{"presign unconfigured", http.MethodPost, "/api/seller/delegate/assets/presign", presign, contract.StorageUnavailable(contract.MsgStorageMissing), 503, `{"error":"委托原图存储未配置，请先在集成设置中配置","code":"storage_unavailable"}`, "private, no-store"},
		{"presign placeholder key", http.MethodPost, "/api/seller/delegate/assets/presign", presign, contract.StorageUnavailable("平台连接配置密钥不能使用 .env.example 中的占位值"), 503, `{"error":"平台连接配置密钥不能使用 .env.example 中的占位值","code":"storage_unavailable"}`, "private, no-store"},
		{"presign short key", http.MethodPost, "/api/seller/delegate/assets/presign", presign, contract.StorageUnavailable("平台连接配置密钥未设置"), 503, `{"error":"平台连接配置密钥未设置","code":"storage_unavailable"}`, "private, no-store"},
		{"presign plaintext", http.MethodPost, "/api/seller/delegate/assets/presign", presign, contract.StorageUnavailable("浏览器直传需要 HTTPS 对象存储地址"), 503, `{"error":"浏览器直传需要 HTTPS 对象存储地址","code":"storage_unavailable"}`, "private, no-store"},
		{"finalize lease", http.MethodPost, "/api/seller/delegate/assets", finalize, contract.WritesDisabled(), 503, `{"error":"委托订单写入未启用","code":"writes_disabled"}`, "private, no-store"},
		{"finalize missing object", http.MethodPost, "/api/seller/delegate/assets", finalize, contract.NotFound("上传对象尚不存在"), 404, `{"error":"上传对象尚不存在","code":"not_found"}`, "private, no-store"},
		{"finalize mismatch", http.MethodPost, "/api/seller/delegate/assets", finalize, contract.Unprocessable("文件内容与上传授权不符，请勿覆盖该对象"), 422, `{"error":"文件内容与上传授权不符，请勿覆盖该对象","code":"validation"}`, "private, no-store"},
		{"finalize session", http.MethodPost, "/api/seller/delegate/assets", finalize, contract.Forbidden("上传期间登录或工作空间已变化"), 403, `{"error":"上传期间登录或工作空间已变化","code":"forbidden"}`, "private, no-store"},
		{"finalize decrypt", http.MethodPost, "/api/seller/delegate/assets", finalize, contract.Internal(), 500, `{"error":"服务暂不可用","code":"internal"}`, "private, no-store"},
		{"delete lease", http.MethodDelete, "/api/seller/delegate/assets/11111111-1111-4111-8111-111111111111", "", contract.WritesDisabled(), 503, `{"error":"委托订单写入未启用","code":"writes_disabled"}`, ""},
		{"delete ok", http.MethodDelete, "/api/seller/delegate/assets/11111111-1111-4111-8111-111111111111", "", nil, 200, `{"data":{"assetId":"a","reclaimed":true}}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			seller := &fakeSeller{err: tc.err}
			r := mountOwner(t, seller, nil)
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tc.status || rec.Body.String() != tc.want || rec.Header().Get("Cache-Control") != tc.cache {
				t.Fatalf("got %d %q cache %q", rec.Code, rec.Body.String(), rec.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestSourcesEnvelope(t *testing.T) {
	seller := &fakeSeller{}
	viewer := chi.NewRouter()
	Mount(viewer, Deps{Session: fixedSession{userID: 7, orgID: 3, role: "viewer"}, Seller: seller})
	rec := httptest.NewRecorder()
	viewer.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/seller/delegate/sources", nil))
	want := `{"data":{"sources":[{"sourceId":"src","name":"厂","country":"CN","icon":"i"}]}}`
	if rec.Code != http.StatusOK || rec.Body.String() != want || seller.canManage {
		t.Fatalf("viewer %d %s manage=%v", rec.Code, rec.Body.Bytes(), seller.canManage)
	}
}

func TestOpenAPIListsDelegateRoutes(t *testing.T) {
	raw := string(mustRead(t, filepath.Join(moduleRoot(t), "api/openapi.yaml")))
	for _, rt := range routes {
		if !strings.Contains(raw, "  \""+rt.path+"\":") {
			t.Fatalf("openapi missing %s", rt.path)
		}
	}
	if !strings.Contains(raw, "      - delegate") {
		t.Fatal("delegate tag")
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod")
		}
		dir = parent
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
