package aihttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCSVFormulaPrefix(t *testing.T) {
	for _, cell := range []string{"=1+1", "+1", "-1", "@sum", "\tcmd", "\r"} {
		got := csvSafe(cell)
		if !strings.HasPrefix(got, "'") {
			t.Fatalf("%q -> %q", cell, got)
		}
	}
	if csvSafe("hello") != "hello" || csvSafe("") != "" {
		t.Fatal("plain")
	}
}

func TestStripOtherHidesAdminKeys(t *testing.T) {
	raw := []byte(`{"admin_info":{"quota_saturation":true},"root_info":1,"audit_info":{},"channel_id":3,"channel_name":"c","channel_type":1,"reject_reason":"no","model_ratio":1.5}`)
	var member map[string]json.RawMessage
	if err := json.Unmarshal(stripOther(raw, false), &member); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"admin_info", "root_info", "audit_info", "channel_id", "channel_name", "channel_type", "reject_reason"} {
		if _, ok := member[key]; ok {
			t.Fatalf("member still has %s", key)
		}
	}
	if _, ok := member["model_ratio"]; !ok {
		t.Fatal("model_ratio")
	}
	if string(stripOther(raw, true)) != string(raw) {
		t.Fatalf("manager %s", stripOther(raw, true))
	}
	if string(stripOther([]byte("nope"), false)) != "{}" {
		t.Fatal("invalid")
	}
}

func TestLogPageSizeIsCapped(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/ai/logs?page_size=1000&p=2&type=2", nil)
	q, err := parseLogQuery(req, true)
	if err != nil || q.Page != 2 || q.PageSize != logPageMax {
		t.Fatalf("%+v %v", q, err)
	}
	over := httptest.NewRequest(http.MethodGet, "/api/ai/logs?p=100001", nil)
	if _, err := parseLogQuery(over, true); err == nil {
		t.Fatal("page")
	}
	bad := httptest.NewRequest(http.MethodGet, "/api/ai/logs?type=9", nil)
	if _, err := parseLogQuery(bad, true); err == nil {
		t.Fatal("type")
	}
}
