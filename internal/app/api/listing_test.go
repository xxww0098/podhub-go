package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	_ "github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	_ "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/tests/parity"
)

type memRules struct {
	rules []listing.Rule
	err   error
	reads int
}

func (m *memRules) EnabledBannedTags(context.Context) ([]listing.Rule, error) {
	m.reads++
	if m.err != nil {
		return nil, m.err
	}
	return append([]listing.Rule(nil), m.rules...), nil
}

func TestListingRulesAndValidateDoNotMutate(t *testing.T) {
	engine, err := listing.OpenEmbedded(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
	mem := &memRules{rules: []listing.Rule{
		{Term: "сигарета", MatchMode: "stem"},
		{Term: "роза", MatchMode: "exact"},
	}}
	handler := HandlerFromMux(&Server{Engine: engine, Rules: mem}, chi.NewRouter())
	version, err := listing.RulesVersion(mem.rules)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/listing/rules", nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusOK,
		Body:   []byte(`{"rules_version":"` + version + `","banned_tags":{"rules":[{"term":"сигарета","match_mode":"stem"},{"term":"роза","match_mode":"exact"}]}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if rec.Header().Get("ETag") != `"`+version+`"` {
		t.Fatal(rec.Header().Get("ETag"))
	}

	req := httptest.NewRequest(http.MethodGet, "/api/listing/rules", nil)
	req.Header.Set("If-None-Match", `"`+version+`"`)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("304 %d %q", rec.Code, rec.Body.Bytes())
	}

	body := `{"rules_version":"` + version + `","tags":["#море","#сигареты","#Роза"],"text":"роза электронная сигарета море"}`
	rec = post(handler, "/api/listing/validate", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("validate %d %s", rec.Code, rec.Body.Bytes())
	}
	var verdict struct {
		RulesVersion string `json:"rules_version"`
		Save         struct {
			OK       bool     `json:"ok"`
			Rejected []string `json:"rejected"`
			Message  string   `json:"message"`
		} `json:"save"`
		AI struct {
			Kept     []string `json:"kept"`
			Rejected []string `json:"rejected"`
		} `json:"ai"`
		BeforeSend struct {
			Text     string   `json:"text"`
			Rejected []string `json:"rejected"`
		} `json:"before_send"`
		Submit struct {
			Rejected             bool   `json:"rejected"`
			Message              string `json:"message"`
			BehaviorChange       string `json:"behavior_change"`
			RustFreezeChecksTags bool   `json:"rust_freeze_checks_tags"`
		} `json:"submit"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &verdict); err != nil {
		t.Fatal(err)
	}
	if verdict.RulesVersion != version || verdict.Save.OK || verdict.Save.Message != "标签含受限词，不能保存：#сигареты、#Роза" {
		t.Fatalf("%+v", verdict)
	}
	// exact роза rejects #Роза. Stem сигарета rejects #сигареты. #море stays,
	// which is also what AI writeback would keep.
	if len(verdict.AI.Kept) != 1 || verdict.AI.Kept[0] != "#море" || len(verdict.AI.Rejected) != 2 {
		t.Fatalf("ai %+v", verdict.AI)
	}
	if verdict.BeforeSend.Text != "электронная море" {
		t.Fatal(verdict.BeforeSend)
	}
	if !verdict.Submit.Rejected || verdict.Submit.RustFreezeChecksTags || verdict.Submit.BehaviorChange != listing.SubmitBannedTagBehaviorChange {
		t.Fatalf("submit %+v", verdict.Submit)
	}

	rec = post(handler, "/api/listing/submit", body)
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusBadRequest,
		Body:   []byte(`{"code":"banned_tag","message":"标签含受限词，不能保存：#сигареты、#Роза","rules_version":"` + version + `","behavior_change":"submit_banned_tag_gate","rust_freeze_checks_tags":false}`),
	}); err != nil {
		t.Fatal(err)
	}

	clean := `{"rules_version":"` + version + `","tags":["#море"],"text":"море"}`
	rec = post(handler, "/api/listing/submit", clean)
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusBadRequest,
		Body:   []byte(`{"code":"validation","message":"请求格式无效"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if mem.reads < 4 {
		t.Fatalf("reads %d", mem.reads)
	}
}

func TestStaleRulesAndMissingEngineFailClosed(t *testing.T) {
	mem := &memRules{rules: []listing.Rule{{Term: "роза", MatchMode: "exact"}}}
	handler := HandlerFromMux(&Server{Rules: mem}, chi.NewRouter())
	version, err := listing.RulesVersion(mem.rules)
	if err != nil {
		t.Fatal(err)
	}
	rec := post(handler, "/api/listing/validate", `{"rules_version":"stale","tags":["#Роза"]}`)
	if rec.Code != http.StatusConflict || !bytes.Contains(rec.Body.Bytes(), []byte(`"code":"rules_stale"`)) || !bytes.Contains(rec.Body.Bytes(), []byte(version)) {
		t.Fatalf("%d %s", rec.Code, rec.Body.Bytes())
	}
	rec = post(handler, "/api/listing/validate", `{"rules_version":"`+version+`","tags":["#Роза"]}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil engine %d %s", rec.Code, rec.Body.Bytes())
	}
	rec = post(handler, "/api/listing/submit", `{"tags":["#Роза"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing version %d %s", rec.Code, rec.Body.Bytes())
	}
	mem.err = errRules
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/listing/rules", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("read %d %s", rec.Code, rec.Body.Bytes())
	}
}

var errRules = errString("db down")

type errString string

func (e errString) Error() string { return string(e) }

func post(handler http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}
