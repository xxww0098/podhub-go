package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
)

const adminContentVideo = `{"name":"Runtime clip","videoUrl":"https://cdn.example.invalid/a.mp4","durationMs":1000,"descriptionCategoryId":11,"typeId":22}`

type adminContentFixture struct {
	identityRuntimeFixture
	server      *httptest.Server
	admin, user string
	org         int64
}

func newAdminContentFixture(t *testing.T) adminContentFixture {
	t.Helper()
	base := newIdentityRuntimeFixture(t)
	var tables, secured int
	if err := base.fixture.QueryRow(base.ctx, `SELECT count(*),count(*) FILTER (WHERE relrowsecurity OR relforcerowsecurity)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname=ANY($1)`, []string{"category_prompts", "category_videos", "ozon_listing_field_templates", "ozon_listing_schema_snapshots", "banned_tags", "audit_logs", "writer_leases", "account_users", "account_sessions"}).Scan(&tables, &secured); err != nil || tables != 9 || secured != 0 {
		t.Fatalf("content platform-table role contract: tables=%d tenant-secured=%d err=%v", tables, secured, err)
	}
	server := httptest.NewServer(base.handler)
	t.Cleanup(server.Close)
	f := adminContentFixture{identityRuntimeFixture: base, server: server}
	for _, actor := range []struct {
		id    int64
		token *string
	}{{96311, &f.admin}, {96312, &f.user}} {
		status, raw := f.call(t, http.MethodPost, "/api/auth/login", fmt.Sprintf(`{"email":"a%d@example.invalid","password":"original-password"}`, actor.id), "")
		var result struct {
			Data struct {
				Token string `json:"token"`
			} `json:"data"`
		}
		if status != http.StatusOK || json.Unmarshal(raw, &result) != nil || result.Data.Token == "" {
			t.Fatalf("real HTTP login status=%d body=%s", status, raw)
		}
		*actor.token = result.Data.Token
	}
	// Login is real; the administrator role is an explicit fixture since these
	// tests exercise content authorization.
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=96311`); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96311`).Scan(&f.org); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO ozon_listing_schema_snapshots(org_id,category_id,updated_at_ms,created_at,updated_at) VALUES($1,'runtime-category',1,clock_timestamp(),clock_timestamp()),($1,'runtime-category',2,clock_timestamp(),clock_timestamp())`, f.org); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, f.ctx, f.fixture, "admin", "admin content runtime")
	platform.InvalidateBannedTags()
	t.Cleanup(platform.InvalidateBannedTags)
	f.assertClean(t)
	return f
}

func (f adminContentFixture) call(t *testing.T, method, path, body, token string) (int, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := f.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, raw
}

func TestAdminContentProductionRoleHTTP(t *testing.T) {
	f := newAdminContentFixture(t)
	t.Run("all content routes refuse stale authority", func(t *testing.T) {
		routes := []struct{ method, path string }{
			{http.MethodGet, "/api/admin/listing/packages/official?category_id=runtime-category"},
			{http.MethodPost, "/api/admin/listing/packages/official"},
			{http.MethodPost, "/api/admin/prompts"},
			{http.MethodPut, "/api/admin/prompts/missing"},
			{http.MethodDelete, "/api/admin/prompts/missing"},
			{http.MethodPost, "/api/admin/videos"},
			{http.MethodPut, "/api/admin/videos/missing"},
			{http.MethodDelete, "/api/admin/videos/missing"},
		}
		for _, tc := range []struct {
			name, token, apply, reset string
			want                      int
		}{
			{"anonymous", "", "", "", http.StatusUnauthorized},
			{"regular user", f.user, "", "", http.StatusForbidden},
			{"role revoked", f.admin, `UPDATE account_users SET role='user' WHERE id=96311`, `UPDATE account_users SET role='super_admin' WHERE id=96311`, http.StatusForbidden},
			{"account disabled", f.admin, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=96311`, `UPDATE account_users SET disabled_at=NULL WHERE id=96311`, http.StatusUnauthorized},
			{"session expired", f.admin, `UPDATE account_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=96311`, `UPDATE account_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE user_id=96311`, http.StatusUnauthorized},
		} {
			t.Run(tc.name, func(t *testing.T) {
				if tc.apply != "" {
					f.exec(t, tc.apply)
					defer f.exec(t, tc.reset)
				}
				for _, route := range routes {
					f.want(t, route.method, route.path, "{}", tc.token, tc.want)
				}
				f.assertClean(t)
			})
		}
		var rows int
		if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM category_prompts)+(SELECT count(*) FROM category_videos)+(SELECT count(*) FROM ozon_listing_field_templates)+(SELECT count(*) FROM audit_logs WHERE module='admin')`).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("refused request persisted rows=%d err=%v", rows, err)
		}
	})
	t.Run("prompt create update delete and validation", func(t *testing.T) {
		body := adminPromptBody(" Runtime prompt ", "brief.md", adminBrief, []string{"#кружка"})
		raw := f.want(t, http.MethodPost, "/api/admin/prompts", body, f.admin, http.StatusCreated)
		id := adminContentID(t, raw, "prompt", "promptId")
		var name, content, by, tags string
		if err := f.fixture.QueryRow(f.ctx, `SELECT name,content,created_by_account_uuid,fixed_tags::text FROM category_prompts WHERE prompt_id=$1`, id).Scan(&name, &content, &by, &tags); err != nil || name != "Runtime prompt" || content != strings.TrimSpace(adminBrief) || !strings.Contains(tags, "#кружка") || by == "" {
			t.Fatalf("persisted prompt name=%q content=%q by=%q tags=%s err=%v", name, content, by, tags, err)
		}
		updated := adminPromptBody("Updated prompt", "revised.txt", adminBrief, []string{"#кружка"})
		f.want(t, http.MethodPut, "/api/admin/prompts/"+id, updated, f.admin, http.StatusOK)
		for _, invalid := range []string{adminPromptBody("", "brief.md", adminBrief, []string{"#кружка"}), adminPromptBody("Bad", "brief.html", adminBrief, []string{"#кружка"}), adminPromptBody("Bad", "brief.md", "one line", []string{"#кружка"}), strings.Replace(body, `"typeId":22`, `"typeId":0`, 1), strings.Replace(body, `"typeId":22`, `"typeId":9223372036854775808`, 1), `{"unknown":true}`} {
			f.want(t, http.MethodPost, "/api/admin/prompts", invalid, f.admin, http.StatusBadRequest)
		}
		f.exec(t, `INSERT INTO banned_tags(term,match_mode,note,created_by) VALUES('кружка','exact','','runtime')`)
		platform.InvalidateBannedTags()
		f.want(t, http.MethodPut, "/api/admin/prompts/"+id, updated, f.admin, http.StatusBadRequest)
		f.exec(t, `DELETE FROM banned_tags WHERE term='кружка'`)
		platform.InvalidateBannedTags()
		f.want(t, http.MethodPut, "/api/admin/prompts/missing", updated, f.admin, http.StatusNotFound)
		if err := f.fixture.QueryRow(f.ctx, `SELECT name FROM category_prompts WHERE prompt_id=$1`, id).Scan(&name); err != nil || name != "Updated prompt" {
			t.Fatalf("refused prompt update changed row: %q %v", name, err)
		}
		f.want(t, http.MethodDelete, "/api/admin/prompts/"+id, "", f.admin, http.StatusOK)
		f.want(t, http.MethodDelete, "/api/admin/prompts/"+id, "", f.admin, http.StatusNotFound)
		f.assertClean(t)
	})
	t.Run("video create update delete and validation", func(t *testing.T) {
		raw := f.want(t, http.MethodPost, "/api/admin/videos", adminContentVideo, f.admin, http.StatusCreated)
		id := adminContentID(t, raw, "video", "videoId")
		updated := strings.Replace(adminContentVideo, "Runtime clip", "Updated clip", 1)
		f.want(t, http.MethodPut, "/api/admin/videos/"+id, updated, f.admin, http.StatusOK)
		for _, invalid := range []string{strings.Replace(adminContentVideo, "https://", "http://", 1), strings.Replace(adminContentVideo, `"durationMs":1000`, `"durationMs":0`, 1), strings.Replace(adminContentVideo, `"durationMs":1000`, `"durationMs":3600001`, 1), strings.Replace(adminContentVideo, `"typeId":22`, `"typeId":0`, 1), `{"unknown":true}`} {
			f.want(t, http.MethodPost, "/api/admin/videos", invalid, f.admin, http.StatusBadRequest)
		}
		f.want(t, http.MethodPut, "/api/admin/videos/missing", updated, f.admin, http.StatusNotFound)
		var name, url string
		var duration int64
		if err := f.fixture.QueryRow(f.ctx, `SELECT name,video_url,duration_ms FROM category_videos WHERE video_id=$1`, id).Scan(&name, &url, &duration); err != nil || name != "Updated clip" || url != "https://cdn.example.invalid/a.mp4" || duration != 1000 {
			t.Fatalf("persisted video %q %q %d %v", name, url, duration, err)
		}
		f.want(t, http.MethodDelete, "/api/admin/videos/"+id, "", f.admin, http.StatusOK)
		f.want(t, http.MethodDelete, "/api/admin/videos/"+id, "", f.admin, http.StatusNotFound)
		f.assertClean(t)
	})
	t.Run("official package binds latest local schema", func(t *testing.T) {
		path := "/api/admin/listing/packages/official"
		missing := f.want(t, http.MethodGet, path+"?category_id=runtime-category", "", f.admin, http.StatusOK)
		if string(missing) != `{"data":{}}` {
			t.Fatalf("missing package: %s", missing)
		}
		body := `{"category_id":"runtime-category","name":" Runtime package ","defaults_json":"{\"value\":1}","dataset_json":"[]"}`
		raw := f.want(t, http.MethodPost, path, body, f.admin, http.StatusCreated)
		var payload struct {
			Data struct {
				OK      bool `json:"ok"`
				Package struct {
					ID        int64  `json:"id"`
					Status    string `json:"status"`
					Name      string `json:"name"`
					Published int64  `json:"published_at_ms"`
				} `json:"package"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil || !payload.Data.OK || payload.Data.Package.Status != "published" || payload.Data.Package.Name != "Runtime package" || payload.Data.Package.Published <= 0 {
			t.Fatalf("published local package: %s %v", raw, err)
		}
		var snapshot, latest, org int64
		var scope, defaults string
		if err := f.fixture.QueryRow(f.ctx, `SELECT schema_snapshot_id,(SELECT id FROM ozon_listing_schema_snapshots WHERE category_id='runtime-category' ORDER BY updated_at_ms DESC,id DESC LIMIT 1),org_id,scope,defaults_json FROM ozon_listing_field_templates WHERE id=$1`, payload.Data.Package.ID).Scan(&snapshot, &latest, &org, &scope, &defaults); err != nil || snapshot != latest || org != 0 || scope != "official" || defaults != `{"value":1}` {
			t.Fatalf("package snapshot=%d latest=%d org=%d scope=%s defaults=%s err=%v", snapshot, latest, org, scope, defaults, err)
		}
		read := f.want(t, http.MethodGet, path+"?category_id=runtime-category", "", f.admin, http.StatusOK)
		if !strings.Contains(string(read), `"name":"Runtime package"`) {
			t.Fatalf("package readback: %s", read)
		}
		f.want(t, http.MethodPost, path, body, f.admin, http.StatusConflict)
		for _, invalid := range []string{`{"category_id":"missing-schema","name":"Package"}`, `{"category_id":"runtime-category","name":""}`, `{"category_id":"runtime-category","name":"Package","defaults_json":"[]"}`, `{"category_id":"runtime-category","name":"Package","dataset_json":"{}"}`, `{"category_id":"runtime-category","name":"Package","unexpected":true}`} {
			f.want(t, http.MethodPost, path, invalid, f.admin, http.StatusBadRequest)
		}
		f.exec(t, `INSERT INTO ozon_listing_schema_snapshots(org_id,category_id,updated_at_ms,created_at,updated_at) VALUES($1,'runtime-category',3,clock_timestamp(),clock_timestamp())`, f.org)
		var still int64
		if err := f.fixture.QueryRow(f.ctx, `SELECT schema_snapshot_id FROM ozon_listing_field_templates WHERE id=$1`, payload.Data.Package.ID).Scan(&still); err != nil || still != snapshot {
			t.Fatalf("published schema binding changed %d %d %v", still, snapshot, err)
		}
		f.assertClean(t)
	})
	var prompts, videos, packages, audits, unfenced int
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM category_prompts),(SELECT count(*) FROM category_videos),(SELECT count(*) FROM ozon_listing_field_templates),(SELECT count(*) FROM audit_logs WHERE module='admin'),(SELECT count(*) FROM audit_logs WHERE module='admin' AND action<>'official_package_read' AND (writer_lease_id IS NULL OR writer_fence_token IS NULL))`).Scan(&prompts, &videos, &packages, &audits, &unfenced); err != nil || prompts != 0 || videos != 0 || packages != 1 || audits != 9 || unfenced != 0 {
		t.Fatalf("persisted totals prompts=%d videos=%d packages=%d audits=%d unfenced=%d err=%v", prompts, videos, packages, audits, unfenced, err)
	}
	f.assertClean(t)
}

func TestAdminContentAuditRollbackAndWriterGate(t *testing.T) {
	f := newAdminContentFixture(t)
	prompt := adminPromptBody("Keep prompt", "brief.md", adminBrief, []string{"#кружка"})
	promptID := adminContentID(t, f.want(t, http.MethodPost, "/api/admin/prompts", prompt, f.admin, http.StatusCreated), "prompt", "promptId")
	videoID := adminContentID(t, f.want(t, http.MethodPost, "/api/admin/videos", adminContentVideo, f.admin, http.StatusCreated), "video", "videoId")
	packageBody := `{"category_id":"runtime-category","name":"Rollback package"}`
	f.exec(t, `ALTER TABLE audit_logs ADD CONSTRAINT admin_content_reject_audit CHECK(module<>'admin') NOT VALID`)
	t.Run("failed audit rolls all content writes back", func(t *testing.T) {
		for _, tc := range []struct{ method, path, body string }{
			{http.MethodPost, "/api/admin/prompts", prompt},
			{http.MethodPut, "/api/admin/prompts/" + promptID, strings.Replace(prompt, "Keep prompt", "Lost prompt", 1)},
			{http.MethodDelete, "/api/admin/prompts/" + promptID, ""},
			{http.MethodPost, "/api/admin/videos", adminContentVideo},
			{http.MethodPut, "/api/admin/videos/" + videoID, strings.Replace(adminContentVideo, "Runtime clip", "Lost clip", 1)},
			{http.MethodDelete, "/api/admin/videos/" + videoID, ""},
			{http.MethodPost, "/api/admin/listing/packages/official", packageBody},
			{http.MethodGet, "/api/admin/listing/packages/official?category_id=runtime-category", ""},
		} {
			f.want(t, tc.method, tc.path, tc.body, f.admin, http.StatusInternalServerError)
		}
		var prompts, videos, packages, audits int
		var promptName, videoName string
		if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM category_prompts),(SELECT count(*) FROM category_videos),(SELECT count(*) FROM ozon_listing_field_templates),(SELECT count(*) FROM audit_logs WHERE module='admin'),(SELECT name FROM category_prompts WHERE prompt_id=$1),(SELECT name FROM category_videos WHERE video_id=$2)`, promptID, videoID).Scan(&prompts, &videos, &packages, &audits, &promptName, &videoName); err != nil || prompts != 1 || videos != 1 || packages != 0 || audits != 2 || promptName != "Keep prompt" || videoName != "Runtime clip" {
			t.Fatalf("audit rollback rows=%d/%d/%d audits=%d names=%q/%q err=%v", prompts, videos, packages, audits, promptName, videoName, err)
		}
		f.assertClean(t)
	})
	f.exec(t, `ALTER TABLE audit_logs DROP CONSTRAINT admin_content_reject_audit`)
	t.Run("expired writer refuses mutations without blocking reads", func(t *testing.T) {
		f.exec(t, `UPDATE writer_leases SET expires_at_ms=1 WHERE domain='admin'`)
		for _, tc := range []struct{ method, path, body string }{
			{http.MethodPost, "/api/admin/prompts", prompt},
			{http.MethodPut, "/api/admin/prompts/" + promptID, prompt},
			{http.MethodDelete, "/api/admin/prompts/" + promptID, ""},
			{http.MethodPost, "/api/admin/videos", adminContentVideo},
			{http.MethodPut, "/api/admin/videos/" + videoID, adminContentVideo},
			{http.MethodDelete, "/api/admin/videos/" + videoID, ""},
			{http.MethodPost, "/api/admin/listing/packages/official", packageBody},
		} {
			f.want(t, tc.method, tc.path, tc.body, f.admin, http.StatusServiceUnavailable)
		}
		f.want(t, http.MethodGet, "/api/admin/listing/packages/official?category_id=runtime-category", "", f.admin, http.StatusOK)
		f.assertClean(t)
	})
	seedMatchingLease(t, f.ctx, f.fixture, "admin", "restored content writer")
	f.want(t, http.MethodPost, "/api/admin/listing/packages/official", packageBody, f.admin, http.StatusCreated)
	f.assertClean(t)
}

func (f adminContentFixture) want(t *testing.T, method, path, body, token string, want int) []byte {
	t.Helper()
	status, raw := f.call(t, method, path, body, token)
	if status != want {
		t.Fatalf("%s %s status=%d want=%d body=%s", method, path, status, want, raw)
	}
	return raw
}

func (f adminContentFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.fixture.Exec(f.ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func adminContentID(t *testing.T, raw []byte, kind, field string) string {
	t.Helper()
	var payload struct {
		Data map[string]map[string]json.RawMessage `json:"data"`
	}
	var id string
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload.Data[kind][field], &id); err != nil || id == "" {
		t.Fatalf("content identifier %s %v", raw, err)
	}
	return id
}
