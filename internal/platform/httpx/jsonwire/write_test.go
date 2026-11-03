package jsonwire

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWritePayload(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload []byte
	}{
		{"ok body", http.StatusOK, []byte(`{"error":"未登录","code":"AUTH_INVALID"}`)},
		{"error status", http.StatusTooManyRequests, []byte(`{"error":"rate"}`)},
		{"empty body", http.StatusNoContent, []byte{}},
		{"bytes that are not utf-8", http.StatusOK, []byte{0xff, 0xfe}},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		WritePayload(rec, tc.status, tc.payload)
		if rec.Code != tc.status {
			t.Fatalf("%s: status %d want %d", tc.name, rec.Code, tc.status)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/json" {
			t.Fatalf("%s: content-type %q", tc.name, got)
		}
		if got := rec.Body.Bytes(); string(got) != string(tc.payload) {
			t.Fatalf("%s: body %q want %q", tc.name, got, tc.payload)
		}
	}
}

func TestWriteSetsSameHeaderOrder(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, http.StatusOK, map[string]int{"b": 2, "a": 1})
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type %q", got)
	}
	if got := rec.Body.String(); got != `{"a":1,"b":2}` {
		t.Fatalf("body %q", got)
	}
}
