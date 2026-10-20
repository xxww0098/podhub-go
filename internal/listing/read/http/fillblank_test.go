package readhttp

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestCrossOriginWrite(t *testing.T) {
	cross := httptest.NewRequest(http.MethodPatch, "/api/listing/rows/x", nil)
	cross.Header.Set("Cookie", "sid=abc")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	if !crossOriginWrite(cross) {
		t.Fatal("cross-site cookie")
	}
	same := httptest.NewRequest(http.MethodPatch, "/api/listing/rows/x", nil)
	same.Header.Set("Cookie", "sid=abc")
	same.Header.Set("Sec-Fetch-Site", "same-origin")
	if crossOriginWrite(same) {
		t.Fatal("same-origin")
	}
	bearer := httptest.NewRequest(http.MethodPatch, "/api/listing/rows/x", nil)
	bearer.Header.Set("Authorization", "Bearer token")
	bearer.Header.Set("Sec-Fetch-Site", "cross-site")
	if crossOriginWrite(bearer) {
		t.Fatal("bearer")
	}
	get := httptest.NewRequest(http.MethodGet, "/api/listing/rows/x", nil)
	get.Header.Set("Cookie", "sid=abc")
	get.Header.Set("Sec-Fetch-Site", "cross-site")
	if crossOriginWrite(get) {
		t.Fatal("get")
	}
}

func TestDBStatusRecycleAndLock(t *testing.T) {
	status, message, code := dbStatus(&pgconn.PgError{Code: "P0M01"})
	if status != http.StatusConflict || message != "媒体对象已进入回收，请重新上传" || code != "internal" {
		t.Fatalf("%d %s %s", status, message, code)
	}
	status, message, code = dbStatus(&pgconn.PgError{Code: "55P03"})
	if status != http.StatusServiceUnavailable || message != "资源正在更新，请稍后重试" || code != "internal" {
		t.Fatalf("%d %s %s", status, message, code)
	}
	rec := httptest.NewRecorder()
	writeDB(rec, &pgconn.PgError{Code: "55P03"})
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("%d %s", rec.Code, rec.Header().Get("Retry-After"))
	}
	rec = httptest.NewRecorder()
	writeDB(rec, &pgconn.PgError{Code: "P0M01"})
	if rec.Code != http.StatusConflict || rec.Header().Get("Retry-After") != "" || rec.Body.String() != `{"error":"媒体对象已进入回收，请重新上传","code":"internal"}` {
		t.Fatalf("%d %s %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
}
