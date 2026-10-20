package adminhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestSupplierX1SuccessBytes(t *testing.T) {
	fixed := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	acc := testStorageAccount()
	origin := &scriptOrigin{status: 200}
	cat := &x1Cat{}
	svc := x1Service(cat, origin, &acc, fixed)
	super := mountX1(svc, "super_admin")
	staff := mountX1(svc, "admin")

	origin.fn = func(req service.ObjectRequest) (service.ObjectResponse, error) {
		if req.Method == http.MethodPut && req.Headers["Content-Type"] != "application/x-directory" {
			t.Fatalf("directory content-type %v", req.Headers)
		}
		return service.ObjectResponse{Status: 200}, nil
	}
	rec := jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/directories", `{"path":"厂家 A"}`)
	if rec.Code != http.StatusCreated || rec.Body.String() != `{"data":{"path":"厂家 A"}}` {
		t.Fatalf("directory %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "private, no-store" || rec.Header().Get("Vary") != "Cookie, Authorization" {
		t.Fatalf("directory headers %v", rec.Header())
	}

	origin.fn = func(req service.ObjectRequest) (service.ObjectResponse, error) {
		if !strings.Contains(req.URL, "list-type=2") || !strings.Contains(req.URL, "max-keys=1000") || !strings.Contains(req.URL, "delimiter=%2F") {
			t.Fatalf("list url %s", req.URL)
		}
		body := `<ListBucketResult><Contents><Key>pod/a.txt</Key><Size>3</Size><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`
		return service.ObjectResponse{Status: 200, Body: []byte(body)}, nil
	}
	rec = jsonCall(super, http.MethodGet, "/api/admin/supplier-db-storage/objects", "")
	const listWant = `{"data":{"prefix":"","items":[{"path":"a.txt","kind":"file","bytes":3,"lastModified":"2020-01-01T00:00:00.000Z","publicUrl":"http://127.0.0.1:9/cdn/pod/a.txt"}]}}`
	if rec.Code != http.StatusOK || rec.Body.String() != listWant {
		t.Fatalf("list %d %s", rec.Code, rec.Body.String())
	}

	origin.fn = func(service.ObjectRequest) (service.ObjectResponse, error) {
		return service.ObjectResponse{Status: 200}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/delete", `{"path":"a.txt","kind":"file"}`)
	const delWant = `{"data":{"path":"a.txt","kind":"file","deleted":1,"missing":0,"failed":0,"remaining":false}}`
	if rec.Code != http.StatusOK || rec.Body.String() != delWant {
		t.Fatalf("delete %d %s", rec.Code, rec.Body.String())
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/move", `{"sourcePath":"a.txt","destinationPath":"b.txt","kind":"file"}`)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":{"sourcePath":"a.txt","destinationPath":"b.txt"}}` {
		t.Fatalf("move %d %s", rec.Code, rec.Body.String())
	}

	origin.fn = func(req service.ObjectRequest) (service.ObjectResponse, error) {
		if req.Method == http.MethodHead {
			return service.ObjectResponse{Status: 404}, nil
		}
		return service.ObjectResponse{Status: 200}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/uploads", `{"path":"a.png","contentType":"image/png","bytes":12,"sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), ".direct-uploads/pub-fixed") || !strings.Contains(rec.Body.String(), "X-Amz-Expires=600") || strings.Contains(rec.Body.String(), "sk-test-secret") {
		t.Fatalf("upload %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"expiresAtMs":1577934845000`) || !strings.Contains(rec.Body.String(), `"ifNoneMatch":"*"`) {
		t.Fatalf("grant %s", rec.Body.String())
	}

	row := sampleRow()
	cat.row = row
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows", fixtureBody(t, "requests/post-row-staff-crud.json"))
	if rec.Code != http.StatusCreated || rec.Body.String() != `{"data":{"row":`+domain.JSONText(row)+`}}` {
		t.Fatalf("row %d %s", rec.Code, rec.Body.String())
	}
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows/scp_1/price", string(mustRead(t, "requests/price.json")))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"platformPriceCents":null`) {
		t.Fatalf("price envelope %d %s", rec.Code, rec.Body.String())
	}

	var rev int32 = 2
	var published int32 = 1
	cat.diff = domain.PromptDiff{Revision: 2, PublishedRevision: &published, Lines: []domain.DiffLine{{Label: "Товар:", Published: "a", Draft: "b", Changed: true}}, PublishedFixedTags: []string{}, DraftFixedTags: []string{"#новый"}, FixedTagsChanged: true, PublishedAiOutput: domain.DefaultAI(), DraftAiOutput: domain.DefaultAI()}
	cat.seen = &rev
	rec = jsonCall(staff, http.MethodGet, "/api/admin/supplier-dbs/src/rows/scp_1/prompt/diff?revision=2&ignored=1", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"publishedRevision":1`) || !strings.Contains(rec.Body.String(), `"fixedTagsChanged":true`) {
		t.Fatalf("diff %d %s", rec.Code, rec.Body.String())
	}
	if cat.gotRev == nil || *cat.gotRev != 2 {
		t.Fatalf("revision query %v", cat.gotRev)
	}

	previewBody := mustRead(t, "hand/preview-chernovik.json")
	var previewWrap struct {
		Request  json.RawMessage `json:"request"`
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal([]byte(previewBody), &previewWrap); err != nil {
		t.Fatal(err)
	}
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows/scp_1/prompt/preview", string(previewWrap.Request))
	if rec.Code != http.StatusOK || compactJSON(rec.Body.String()) != compactJSON(string(previewWrap.Response)) {
		t.Fatalf("preview %d %s", rec.Code, rec.Body.String())
	}

	cat.sync = domain.EmptySync()
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-prompts/sync", "")
	var syncWrap struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(mustRead(t, "hand/sync-empty.json"), &syncWrap); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK || compactJSON(rec.Body.String()) != compactJSON(string(syncWrap.Response)) {
		t.Fatalf("sync %d %s", rec.Code, rec.Body.String())
	}

	cat.prompt = domain.Prompt{ProductID: "scp_1", SourceID: "src", ProductTitle: "马克杯", DescriptionCategoryID: 1, TypeID: 2, PromptName: "草稿", PromptFileName: "draft.md", PromptContent: "ЧЕРНОВИК", FixedTags: []string{"#новый"}, Revision: 4}
	rec = jsonCall(staff, http.MethodPatch, "/api/admin/supplier-prompts/scp_1", string(mustRead(t, "requests/patch-prompt-chernovik.json")))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"prompt":{"productId":"scp_1"`) || !strings.Contains(rec.Body.String(), "ЧЕРНОВИК") {
		t.Fatalf("patch %d %s", rec.Code, rec.Body.String())
	}

	cat.pub = domain.PromptPublish{ProductID: "scp_1", Revision: 2, PublishedRevision: 2, ProductRevision: 5, ConfigRevision: 3}
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows/scp_1/prompt/publish", string(mustRead(t, "requests/prompt-publish.json")))
	if rec.Code != http.StatusOK || rec.Body.String() != `{"data":`+domain.JSONText(cat.pub)+`}` {
		t.Fatalf("publish prompt %d %s", rec.Code, rec.Body.String())
	}

	before := origin.calls
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/uploads/abort", `{}`)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 || origin.calls != before {
		t.Fatalf("abort %d %q calls %d", rec.Code, rec.Body.String(), origin.calls-before)
	}
	if rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("abort cache %q", rec.Header().Get("Cache-Control"))
	}
}

func TestSupplierX1ErrorBranches(t *testing.T) {
	fixed := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	acc := testStorageAccount()
	origin := &scriptOrigin{status: 200}
	cat := &x1Cat{}
	svc := x1Service(cat, origin, &acc, fixed)
	super := mountX1(svc, "super_admin")
	staff := mountX1(svc, "admin")
	user := mountX1(svc, "user")

	rec := call(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows", `{"title":"x"}`)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"请求格式无效","code":"VALIDATION"}` {
		t.Fatalf("content-type %d %s", rec.Code, rec.Body.String())
	}

	rec = jsonCall(super, http.MethodGet, "/api/admin/supplier-db-storage/objects?foo=1", "")
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Content-Type") != "text/plain; charset=utf-8" || !strings.HasPrefix(rec.Body.String(), "Failed to deserialize query string: ") || !strings.Contains(rec.Body.String(), "foo") || strings.HasPrefix(rec.Body.String(), "{") {
		t.Fatalf("unknown query %d %s %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	rec = jsonCall(staff, http.MethodGet, "/api/admin/supplier-dbs/src/rows/scp_1/prompt/diff?revision=abc", "")
	if rec.Code != http.StatusBadRequest || rec.Body.String() != "Failed to deserialize query string: revision: invalid digit found in string" {
		t.Fatalf("revision %d %s", rec.Code, rec.Body.String())
	}
	rec = jsonCall(super, http.MethodGet, "/api/admin/supplier-db-storage/objects?cursor=", "")
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"cursor 无效","code":"VALIDATION"}` {
		t.Fatalf("cursor %d %s", rec.Code, rec.Body.String())
	}

	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-db-storage/directories", `{"path":"a"}`)
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"error":"需要超级管理员权限","code":"FORBIDDEN"}` {
		t.Fatalf("staff storage %d %s", rec.Code, rec.Body.String())
	}
	rec = jsonCall(user, http.MethodPost, "/api/admin/supplier-dbs/src/rows", `{}`)
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"error":"需要平台管理员权限","code":"FORBIDDEN"}` {
		t.Fatalf("user row %d %s", rec.Code, rec.Body.String())
	}

	bare := x1Service(cat, origin, nil, fixed)
	rec = jsonCall(mountX1(bare, "super_admin"), http.MethodGet, "/api/admin/supplier-db-storage/objects", "")
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"error":"先配置平台货源存储桶","code":"STORAGE_NOT_CONFIGURED"}` {
		t.Fatalf("unconfigured %d %s", rec.Code, rec.Body.String())
	}

	origin.fn = func(service.ObjectRequest) (service.ObjectResponse, error) {
		return service.ObjectResponse{}, context.DeadlineExceeded
	}
	rec = jsonCall(super, http.MethodGet, "/api/admin/supplier-db-storage/objects", "")
	if rec.Code != http.StatusBadGateway || rec.Body.String() != `{"error":"对象存储暂不可用","code":"STORAGE_UNAVAILABLE"}` {
		t.Fatalf("origin down %d %s", rec.Code, rec.Body.String())
	}
	origin.fn = func(req service.ObjectRequest) (service.ObjectResponse, error) {
		if req.Method == http.MethodPut {
			return service.ObjectResponse{Status: 404}, nil
		}
		return service.ObjectResponse{Status: 200}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/move", `{"sourcePath":"a.txt","destinationPath":"b.txt","kind":"file"}`)
	if rec.Code != http.StatusNotFound || rec.Body.String() != `{"error":"对象不存在","code":"NOT_FOUND"}` {
		t.Fatalf("copy 404 %d %s", rec.Code, rec.Body.String())
	}
	origin.fn = func(req service.ObjectRequest) (service.ObjectResponse, error) {
		if req.Method == http.MethodPut {
			return service.ObjectResponse{Status: 200, Body: []byte(`<Error><Code>InternalError</Code></Error>`)}, nil
		}
		return service.ObjectResponse{Status: 200}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/move", `{"sourcePath":"a.txt","destinationPath":"b.txt","kind":"file"}`)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), `"code":"STORAGE_UNAVAILABLE"`) {
		t.Fatalf("copy error xml %d %s", rec.Code, rec.Body.String())
	}

	cat.referenced = true
	origin.fn = func(service.ObjectRequest) (service.ObjectResponse, error) {
		return service.ObjectResponse{Status: 200}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/delete", `{"path":"a.txt","kind":"file"}`)
	if rec.Code != http.StatusConflict || rec.Body.String() != `{"error":"对象仍被平台货源商品引用；请先移除 URL 引用再操作","code":"CONFLICT"}` {
		t.Fatalf("referenced %d %s", rec.Code, rec.Body.String())
	}
	cat.referenced = false
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/delete", `{"path":".direct-uploads/a","kind":"file"}`)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"该路径为上传暂存或确认事实保留路径","code":"VALIDATION"}` {
		t.Fatalf("reserved %d %s", rec.Code, rec.Body.String())
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/move", `{"sourcePath":"a.txt","destinationPath":"a.txt","kind":"file"}`)
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"源路径与目标路径不能相同","code":"VALIDATION"}` {
		t.Fatalf("same path %d %s", rec.Code, rec.Body.String())
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/objects/move", `{"sourcePath":"a","destinationPath":"b","kind":"directory"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "暂不支持移动目录") {
		t.Fatalf("dir move %d %s", rec.Code, rec.Body.String())
	}

	origin.fn = func(service.ObjectRequest) (service.ObjectResponse, error) {
		return service.ObjectResponse{Status: 503}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/directories", `{"path":"a"}`)
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"error":"服务暂不可用","code":"INTERNAL"}` {
		t.Fatalf("dir 503 %d %s", rec.Code, rec.Body.String())
	}
	origin.fn = func(service.ObjectRequest) (service.ObjectResponse, error) {
		return service.ObjectResponse{Status: 500}, nil
	}
	rec = jsonCall(super, http.MethodPost, "/api/admin/supplier-db-storage/directories", `{"path":"a"}`)
	if rec.Code != http.StatusInternalServerError || rec.Body.String() != `{"error":"服务暂不可用","code":"INTERNAL"}` {
		t.Fatalf("dir 500 %d %s", rec.Code, rec.Body.String())
	}

	cat.err = &contract.Fail{Kind: contract.KindWritesDisabled}
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows", fixtureBody(t, "requests/post-row-staff-crud.json"))
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"error":"平台货源写入未启用","code":"WRITES_DISABLED"}` {
		t.Fatalf("lease %d %s", rec.Code, rec.Body.String())
	}
	cat.err = &contract.Fail{Kind: contract.KindValidation, Message: "商品尚未满足上架条件", Missing: []string{"category", "prompt", "fixedTags", "platformPrice", "ozonConfig"}}
	rec = jsonCall(staff, http.MethodPost, "/api/admin/supplier-dbs/src/rows/scp_1/publish", "")
	if rec.Code != http.StatusBadRequest || rec.Body.String() != `{"error":"商品尚未满足上架条件","code":"VALIDATION","missing":["category","prompt","fixedTags","platformPrice","ozonConfig"]}` {
		t.Fatalf("missing %d %s", rec.Code, rec.Body.String())
	}

	remote := testStorageAccount()
	remote.Endpoint = "https://example.com"
	remoteSvc := x1Service(&x1Cat{}, LoopbackOrigin{}, &remote, fixed)
	rec = jsonCall(mountX1(remoteSvc, "super_admin"), http.MethodGet, "/api/admin/supplier-db-storage/objects", "")
	if rec.Code != http.StatusBadGateway || rec.Body.String() != `{"error":"对象存储暂不可用","code":"STORAGE_UNAVAILABLE"}` {
		t.Fatalf("non-loopback %d %s", rec.Code, rec.Body.String())
	}
	if _, err := (LoopbackOrigin{}).Do(context.Background(), service.ObjectRequest{Method: http.MethodGet, URL: "http://example.com/bucket"}); err == nil {
		t.Fatal("loopback origin dialed a public host")
	}
}

func sampleRow() domain.RowData {
	row := domain.RowData{
		ProductID: "scp_1", SKU: "scs_1", SourceID: "src", Title: "纯棉短袖", PlatformCode: "DB-001",
		Revision: 1, CreatedBy: "pub", LeadTime: "3-5 天",
	}
	row.EmptyRowSlices()
	row.FillReadiness(domain.RowFacts{SourceListed: true})
	return row
}

func x1Service(cat service.Rows, origin service.Origin, account *sign.Account, now time.Time) service.Service {
	svc := service.New(fakeStore{})
	svc.Cat = cat
	svc.Origin = origin
	svc.Now = func() time.Time { return now }
	svc.PublicID = func() (string, error) { return "pub-fixed", nil }
	if account != nil {
		acc := *account
		svc.Accounts = func(context.Context) (sign.Account, bool, error) { return acc, true, nil }
	}
	return svc
}

func mountX1(svc service.Service, role string) http.Handler {
	h := chi.NewRouter()
	Mount(h, Deps{Resolve: fixed(access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 1, PlatformRole: role}}), Supplier: &svc})
	return h
}

func jsonCall(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" || method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func testStorageAccount() sign.Account {
	return sign.Account{
		ID: "acc", Provider: sign.ProviderGeneric, Endpoint: "http://127.0.0.1:9", Region: "auto",
		Bucket: "supplier-db-bucket", KeyPrefix: "pod", PublicBaseURL: "http://127.0.0.1:9/cdn", ForcePathStyle: true,
		AccessKeyID: "AKID", SecretAccessKey: "sk-test-secret",
	}
}

func fixtureBody(t *testing.T, name string) string {
	t.Helper()
	var wrap struct {
		Body json.RawMessage `json:"body"`
	}
	raw := mustRead(t, name)
	if err := json.Unmarshal(raw, &wrap); err != nil || len(wrap.Body) == 0 {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return string(wrap.Body)
}

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("../domain/testdata/x1/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func compactJSON(s string) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(s)); err != nil {
		return s
	}
	return buf.String()
}

type scriptOrigin struct {
	status int
	fn     func(service.ObjectRequest) (service.ObjectResponse, error)
	calls  int
}

func (s *scriptOrigin) Do(_ context.Context, req service.ObjectRequest) (service.ObjectResponse, error) {
	s.calls++
	if s.fn != nil {
		return s.fn(req)
	}
	return service.ObjectResponse{Status: s.status}, nil
}

type x1Cat struct {
	row        domain.RowData
	cfg        domain.OzonConfig
	diff       domain.PromptDiff
	pub        domain.PromptPublish
	prompt     domain.Prompt
	sync       domain.SyncReport
	referenced bool
	err        error
	seen       *int32
	gotRev     *int32
}

func (c *x1Cat) Detail(context.Context, contract.Actor, string, int64) (domain.DbDetail, error) {
	if c.err != nil {
		return domain.DbDetail{}, c.err
	}
	return domain.DbDetail{DB: domain.SupplierDb{}, PropDefs: []domain.Prop{}, Rows: []domain.RowData{}}, nil
}
func (c *x1Cat) CreateRow(context.Context, contract.Actor, string, domain.RowInput, string, string, string, int64) (domain.RowData, error) {
	return c.row, c.err
}
func (c *x1Cat) UpdateRow(context.Context, contract.Actor, string, string, domain.RowInput, int64) (domain.RowData, error) {
	return c.row, c.err
}
func (c *x1Cat) AdjustPrice(context.Context, contract.Actor, string, string, int64, string, int64) (domain.RowData, error) {
	return c.row, c.err
}
func (c *x1Cat) SetPublished(context.Context, contract.Actor, string, string, bool, int64) (domain.RowData, error) {
	return c.row, c.err
}
func (c *x1Cat) LoadOzon(context.Context, contract.Actor, string, string, int64) (domain.OzonConfig, error) {
	return c.cfg, c.err
}
func (c *x1Cat) SaveOzon(context.Context, contract.Actor, string, string, domain.OzonPut, int64) (domain.OzonConfig, error) {
	return c.cfg, c.err
}
func (c *x1Cat) PromptDiff(_ context.Context, _ contract.Actor, _, _ string, revision *int32) (domain.PromptDiff, error) {
	c.gotRev = revision
	return c.diff, c.err
}
func (c *x1Cat) PublishPrompt(context.Context, contract.Actor, string, string, int32, int64) (domain.PromptPublish, error) {
	return c.pub, c.err
}
func (c *x1Cat) PatchPrompt(context.Context, contract.Actor, string, domain.PromptPatchInput, int64) (domain.Prompt, error) {
	return c.prompt, c.err
}
func (c *x1Cat) SyncPrompts(context.Context, contract.Actor, int64) (domain.SyncReport, error) {
	if c.err != nil {
		return domain.SyncReport{}, c.err
	}
	if c.sync.Updated == nil {
		c.sync = domain.EmptySync()
	}
	return c.sync, nil
}
func (c *x1Cat) Referenced(context.Context, contract.Actor, []string) (bool, error) {
	return c.referenced, nil
}
func (c *x1Cat) Banned(context.Context, contract.Actor) ([]string, error) {
	return []string{}, c.err
}
