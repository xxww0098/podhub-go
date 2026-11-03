package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fieldpackCoordinate = "?descriptionCategoryId=17027906&typeId=91976&language=zh_hans"

func TestFieldPackProductionRoleRoutes(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	token := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "fieldpack-routes"))
	var id string
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO ozon_field_packs(author_user_id,name,description_category_id,type_id,language,defaults_json,shared,active,updated_at_ms) VALUES(96311,'Seed',17027906,91976,'zh_hans','{}',true,true,1) RETURNING id::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, path, body string
		status                   int
	}{
		{"list frontend query", http.MethodGet, "/api/field-packs" + fieldpackCoordinate, "", http.StatusOK},
		{"library frontend query", http.MethodGet, "/api/field-library" + fieldpackCoordinate, "", http.StatusOK},
		{"create", http.MethodPost, "/api/field-packs", fieldpackCreateBody("Created"), http.StatusOK},
		{"patch", http.MethodPatch, "/api/field-packs/" + id, `{"name":"Renamed","active":true}`, http.StatusOK},
		{"share", http.MethodPost, "/api/field-packs/" + id + "/share", `{"shared":false}`, http.StatusOK},
		{"delete", http.MethodDelete, "/api/field-packs/" + id, "", http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := f.request(tc.method, tc.path, tc.body, token, "")
			if response.Code != tc.status {
				t.Fatalf("route status=%d want=%d body=%s", response.Code, tc.status, response.Body.String())
			}
			if tc.method == http.MethodGet {
				if packs := fieldpackList(t, response); len(packs) != 1 || packs[0].ID != id {
					t.Fatalf("seeded pack missing: %+v", packs)
				}
			}
			f.assertClean(t)
		})
	}
}

func TestFieldPackProductionRoleLifecycle(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	owner := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "fieldpack-owner"))
	other := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96312@example.invalid","password":"original-password"}`, "", "fieldpack-other"))
	first := fieldpackResponse(t, f.request(http.MethodPost, "/api/field-packs", fieldpackCreateBody("First"), owner, ""))
	second := fieldpackResponse(t, f.request(http.MethodPost, "/api/field-packs", fieldpackCreateBody("Second"), owner, ""))
	if !first.Active || second.Active || first.Shared || second.Shared || !first.AuthorIsSelf || first.Source != "cloud" {
		t.Fatalf("initial pack flags: first=%+v second=%+v", first, second)
	}
	if packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-packs"+fieldpackCoordinate, "", owner, "")); len(packs) != 2 || packs[0].ID != first.ID {
		t.Fatalf("owner list=%+v", packs)
	}
	if packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-packs"+fieldpackCoordinate, "", other, "")); len(packs) != 0 {
		t.Fatalf("private packs leaked: %+v", packs)
	}
	if packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-library"+fieldpackCoordinate, "", other, "")); len(packs) != 0 {
		t.Fatalf("unshared packs published: %+v", packs)
	}
	for _, tc := range []struct{ method, suffix, body string }{
		{http.MethodPatch, "", `{"name":"Stolen","active":true}`},
		{http.MethodPost, "/share", `{"shared":true}`},
		{http.MethodDelete, "", ""},
	} {
		response := f.request(tc.method, "/api/field-packs/"+first.ID+tc.suffix, tc.body, other, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("foreign %s: %d %s", tc.method, response.Code, response.Body.String())
		}
	}
	patch := `{"name":"Selected","active":true,"draft":{"values":{"title":{"kind":"text","value":"updated"}},"complex_values":[],"cleared":["old"]}}`
	for range 2 {
		updated := fieldpackResponse(t, f.request(http.MethodPatch, "/api/field-packs/"+second.ID, patch, owner, ""))
		if !updated.Active || updated.Name != "Selected" {
			t.Fatalf("activate/replay=%+v", updated)
		}
	}
	var activeCount int
	var activeID, savedDraft string
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*),min(id::text) FROM ozon_field_packs WHERE author_user_id=96311 AND active`).Scan(&activeCount, &activeID); err != nil || activeCount != 1 || activeID != second.ID {
		t.Fatalf("active count=%d id=%s err=%v", activeCount, activeID, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT defaults_json FROM ozon_field_packs WHERE id=$1::uuid`, second.ID).Scan(&savedDraft); err != nil || savedDraft != `{"values":{"title":{"kind":"text","value":"updated"}},"complex_values":[],"cleared":["old"]}` {
		t.Fatalf("persisted draft=%s err=%v", savedDraft, err)
	}
	for range 2 {
		shared := fieldpackResponse(t, f.request(http.MethodPost, "/api/field-packs/"+second.ID+"/share", `{"shared":true}`, owner, ""))
		if !shared.Shared || shared.LibraryID != second.ID {
			t.Fatalf("share/replay=%+v", shared)
		}
	}
	if packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-library"+fieldpackCoordinate, "", other, "")); len(packs) != 1 || packs[0].ID != second.ID {
		t.Fatalf("published library=%+v", packs)
	}
	// Sharing publishes a copyable library entry; it never grants edit access.
	if response := f.request(http.MethodPatch, "/api/field-packs/"+second.ID, `{"name":"Other"}`, other, ""); response.Code != http.StatusNotFound {
		t.Fatalf("shared pack writable by another user: %d %s", response.Code, response.Body.String())
	}
	fieldpackResponse(t, f.request(http.MethodPost, "/api/field-packs/"+second.ID+"/share", `{"shared":false}`, owner, ""))
	if packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-library"+fieldpackCoordinate, "", other, "")); len(packs) != 0 {
		t.Fatalf("unshare left library entry=%+v", packs)
	}
	for _, want := range []int{http.StatusNoContent, http.StatusNotFound} {
		if response := f.request(http.MethodDelete, "/api/field-packs/"+second.ID, "", owner, ""); response.Code != want {
			t.Fatalf("delete/replay: %d want=%d %s", response.Code, want, response.Body.String())
		}
	}
	f.assertClean(t)
}

func TestFieldPackProductionRoleRefusalsAndRollback(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	token := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "fieldpack-refusals"))
	first := fieldpackResponse(t, f.request(http.MethodPost, "/api/field-packs", fieldpackCreateBody("First"), token, ""))
	second := fieldpackResponse(t, f.request(http.MethodPost, "/api/field-packs", fieldpackCreateBody("Second"), token, ""))
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/field-packs" + fieldpackCoordinate, ""},
		{http.MethodGet, "/api/field-library" + fieldpackCoordinate, ""},
		{http.MethodPost, "/api/field-packs", fieldpackCreateBody("Refused")},
		{http.MethodPatch, "/api/field-packs/" + first.ID, `{"active":false}`},
		{http.MethodPost, "/api/field-packs/" + first.ID + "/share", `{"shared":true}`},
		{http.MethodDelete, "/api/field-packs/" + first.ID, ""},
	} {
		for _, credential := range []string{"", "unknown-token"} {
			response := f.request(tc.method, tc.path, tc.body, credential, "")
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("invalid credential %s %s: %d %s", tc.method, tc.path, response.Code, response.Body.String())
			}
		}
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/field-packs?description_category_id=17027906&type_id=91976", ""},
		{http.MethodGet, "/api/field-packs?descriptionCategoryId=bad&typeId=91976", ""},
		{http.MethodGet, "/api/field-library?descriptionCategoryId=17027906&typeId=91976&language=unknown", ""},
		{http.MethodPost, "/api/field-packs", `{"coordinate":{"language":"zh_hans"},"draft":{"values":{"bad":{"kind":"decimal","value":1.5}}}}`},
		{http.MethodPatch, "/api/field-packs/" + second.ID, `{"active":true,"draft":{"unknown":true}}`},
		{http.MethodPost, "/api/field-packs/" + second.ID + "/share", `{"shared":"yes"}`},
	} {
		response := f.request(tc.method, tc.path, tc.body, token, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid input %s %s: %d %s", tc.method, tc.path, response.Code, response.Body.String())
		}
	}
	// Fail after switching active rows to prove the entire transaction rolls back.
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE ozon_field_packs ADD CONSTRAINT fieldpack_test_reject_name CHECK (name <> 'reject-after-activation')`); err != nil {
		t.Fatal(err)
	}
	response := f.request(http.MethodPatch, "/api/field-packs/"+second.ID, `{"active":true,"name":"reject-after-activation"}`, token, "")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("failed activation: %d %s", response.Code, response.Body.String())
	}
	packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-packs"+fieldpackCoordinate, "", token, ""))
	if len(packs) != 2 || packs[0].ID != first.ID || !packs[0].Active || packs[0].Shared || packs[1].Active || packs[1].Name != "Second" || packs[1].Shared {
		t.Fatalf("refused request changed packs: %+v", packs)
	}
	t.Run("read errors are not empty success", func(t *testing.T) {
		if _, err := f.fixture.Exec(f.ctx, `REVOKE SELECT ON ozon_field_packs FROM podhub_app`); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"/api/field-packs", "/api/field-library"} {
			response := f.request(http.MethodGet, path+fieldpackCoordinate, "", token, "")
			if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), `"packs"`) {
				t.Fatalf("denied read %s: %d %s", path, response.Code, response.Body.String())
			}
			f.assertClean(t)
		}
		if _, err := f.fixture.Exec(f.ctx, `GRANT SELECT ON ozon_field_packs TO podhub_app`); err != nil {
			t.Fatal(err)
		}
		if packs := fieldpackList(t, f.request(http.MethodGet, "/api/field-packs"+fieldpackCoordinate, "", token, "")); len(packs) != 2 {
			t.Fatalf("read did not recover: %+v", packs)
		}
	})
	if response := f.request(http.MethodPost, "/api/auth/logout", `{}`, token, ""); response.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", response.Code, response.Body.String())
	}
	if response := f.request(http.MethodDelete, "/api/field-packs/"+first.ID, "", token, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session accepted: %d %s", response.Code, response.Body.String())
	}
	f.assertClean(t)
}

type fieldpackResult struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Active       bool   `json:"active"`
	Shared       bool   `json:"shared"`
	AuthorIsSelf bool   `json:"author_is_self"`
	Source       string `json:"source"`
	LibraryID    string `json:"library_id"`
}

func fieldpackCreateBody(name string) string {
	return fmt.Sprintf(`{"name":%q,"coordinate":{"description_category_id":17027906,"type_id":91976,"language":"zh_hans"},"draft":{"values":{"title":{"kind":"text","value":"original"}},"complex_values":[]}}`, name)
}

func fieldpackResponse(t *testing.T, response *httptest.ResponseRecorder) fieldpackResult {
	t.Helper()
	var result struct {
		Data fieldpackResult `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Data.ID == "" {
		t.Fatalf("field pack response: %d %s", response.Code, response.Body.String())
	}
	return result.Data
}

func fieldpackList(t *testing.T, response *httptest.ResponseRecorder) []fieldpackResult {
	t.Helper()
	var result struct {
		Data struct {
			Packs []fieldpackResult `json:"packs"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || !strings.Contains(response.Body.String(), `"packs":[`) {
		t.Fatalf("field pack list: %d %s", response.Code, response.Body.String())
	}
	return result.Data.Packs
}
