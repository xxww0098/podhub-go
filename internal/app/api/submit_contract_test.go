package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestStoredSubmitRefusalsMatchOpenAPI(t *testing.T) {
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	for _, refusal := range []submit.Status{
		{Code: http.StatusBadRequest, Kind: "bad_request", Message: "请求格式无效"},
		{Code: http.StatusConflict, Kind: "revision_mismatch", Message: "商品已变更，本批次未入队，请刷新后重试"},
		{Code: http.StatusConflict, Kind: "schema_sync_required", Message: "正在更新类目字段，请稍后重试"},
		{Code: http.StatusServiceUnavailable, Kind: "internal", Message: "服务暂不可用"},
	} {
		t.Run(refusal.Kind, func(t *testing.T) {
			rec := httptest.NewRecorder()
			if !writeSubmit(rec, refusal) {
				t.Fatal("submit refusal was not written")
			}
			if err := spec.CheckResponse(http.MethodPost, "/api/listing/submit", rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
				t.Fatal(err)
			}
		})
	}
}
