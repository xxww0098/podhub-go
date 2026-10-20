package readhttp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestCreateCardRefusalsDoNotTouchADatabase(t *testing.T) {
	h := Host{Access: access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 1, WorkspaceRole: "owner"}}}
	cases := []struct {
		body   string
		status int
		code   string
	}{
		{`{"createMode":"fromPack"}`, http.StatusBadRequest, "不再支持字段包导入"},
		{`{"createMode":"blank","fieldPackId":"x"}`, http.StatusBadRequest, "此创建方式不接受 fieldPackId"},
		{`{"createMode":"blank"}`, http.StatusBadRequest, "上架方案载荷不是可用的方案文档"},
		{`{"createMode":"fromSupplier","supplierProductId":"p"}`, http.StatusInternalServerError, "internal"},
		{`{"createMode":"copyCard"}`, http.StatusBadRequest, "copyCard 需要 sourceCardId"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/listing/cards", strings.NewReader(tc.body))
		h.createCard(rec, req)
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.code) {
			t.Fatalf("%s → %d %s", tc.body, rec.Code, rec.Body.String())
		}
	}
	viewer := Host{Access: access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 1, WorkspaceRole: "viewer"}}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/listing/cards", strings.NewReader(`{"createMode":"blank"}`))
	viewer.createCard(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer %d %s", rec.Code, rec.Body.String())
	}
}
