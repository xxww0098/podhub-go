package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	_ "github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	_ "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/tests/parity"
)

func testBannedTagRules(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	var rls bool
	if err := pool.QueryRow(ctx, `
		SELECT c.relrowsecurity
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname = 'banned_tags'`).Scan(&rls); err != nil {
		t.Fatal(err)
	}
	if rls {
		t.Fatal("banned_tags is a platform table and must not enable tenant RLS")
	}
	var policies int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM pg_policy p
		JOIN pg_class c ON c.oid = p.polrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname = 'banned_tags'`).Scan(&policies); err != nil {
		t.Fatal(err)
	}
	if policies != 0 {
		t.Fatalf("policies %d", policies)
	}

	before := tableCounts(t, ctx, pool)
	engine, err := listing.OpenEmbedded(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })
	handler := httpapi.HandlerFromMux(&httpapi.Server{Pool: pool, Engine: engine}, chi.NewRouter())

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/listing/rules", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("rules %d %s", rec.Code, rec.Body.Bytes())
	}
	var doc struct {
		RulesVersion string `json:"rules_version"`
		BannedTags   struct {
			Rules []struct {
				Term      string `json:"term"`
				MatchMode string `json:"match_mode"`
			} `json:"rules"`
		} `json:"banned_tags"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.BannedTags.Rules) != 6 {
		t.Fatalf("rules %+v", doc.BannedTags.Rules)
	}
	for _, rule := range doc.BannedTags.Rules {
		if rule.MatchMode != "stem" && rule.MatchMode != "exact" {
			t.Fatal(rule.MatchMode)
		}
	}
	rules := make([]listing.Rule, len(doc.BannedTags.Rules))
	for i, rule := range doc.BannedTags.Rules {
		rules[i] = listing.Rule{Term: rule.Term, MatchMode: rule.MatchMode}
	}
	wantVersion, err := listing.RulesVersion(rules)
	if err != nil || wantVersion != doc.RulesVersion {
		t.Fatalf("version %s %s %v", doc.RulesVersion, wantVersion, err)
	}

	body := `{"rules_version":"` + doc.RulesVersion + `","tags":["#сигареты","#роза"],"text":"роза"}`
	req := httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(body))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusBadRequest,
		Body:   []byte(`{"code":"banned_tag","message":"标签含受限词，不能保存：#сигареты","rules_version":"` + doc.RulesVersion + `","behavior_change":"submit_banned_tag_gate","rust_freeze_checks_tags":false}`),
	}); err != nil {
		t.Fatal(err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/listing/validate", strings.NewReader(`{"rules_version":"`+doc.RulesVersion+`","tags":["#роза"],"text":"роза"}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("validate %d %s", rec.Code, rec.Body.Bytes())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(`{"rules_version":"`+doc.RulesVersion+`","tags":["#роза"],"text":"роза"}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusBadRequest,
		Body:   []byte(`{"code":"validation","message":"请求格式无效"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if err := parity.DiffCounts(before, tableCounts(t, ctx, pool)); err != nil {
		t.Fatal(err)
	}
}
