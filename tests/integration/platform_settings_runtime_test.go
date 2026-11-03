package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestBannedTagsProductionRoleCRUD(t *testing.T) {
	f := newAdminContentFixture(t)
	const path = "/api/admin/banned-tags"
	const term = "qa20261027"
	const body = `{"term":"qa20261027","matchMode":"exact","note":"qa-20261027","enabled":true}`
	f.want(t, http.MethodGet, path, "", f.admin, 200)
	f.want(t, http.MethodPost, path, body, f.user, 403)
	f.want(t, http.MethodPost, path, body, f.admin, 200)
	f.want(t, http.MethodPost, path, body, f.admin, 409)
	var id string
	if err := f.fixture.QueryRow(f.ctx, `SELECT id::text FROM banned_tags WHERE term=$1`, term).Scan(&id); err != nil {
		t.Fatal(err)
	}
	f.want(t, http.MethodPut, path+"/"+id, strings.Replace(body, `"enabled":true`, `"enabled":false`, 1), f.admin, 200)
	var enabled bool
	if err := f.fixture.QueryRow(f.ctx, `SELECT enabled FROM banned_tags WHERE term=$1`, term).Scan(&enabled); err != nil || enabled {
		t.Fatalf("tag was not disabled: %v %v", enabled, err)
	}
	f.want(t, http.MethodDelete, path+"/"+id, "", f.admin, 200)
	f.want(t, http.MethodDelete, path+"/"+id, "", f.admin, 404)
	var audits int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM audit_logs WHERE entity_type='banned_tag' AND entity_id=$1`, id).Scan(&audits); err != nil || audits != 3 {
		t.Fatalf("CRUD audits=%d err=%v", audits, err)
	}
	f.assertClean(t)
}

func TestCatalogFetchConfigProductionRoleSave(t *testing.T) {
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "qa-catalog-settings-32-byte-test-key")
	f := newAdminContentFixture(t)
	const path = "/api/admin/catalog/fetch-config"
	const body = `{"enabled":false,"schedule_mode":"fixed","at_minute":210,"window_start_minute":120,"window_end_minute":240,"utc_offset_minutes":480,"keys":[{"client_id":"qa-20261027","api_key":"qa-test-key"}]}`
	f.want(t, http.MethodPut, path, body, f.user, 403)
	saved := f.want(t, http.MethodPut, path, body, f.admin, 200)
	var view struct {
		At   int `json:"at_minute"`
		Keys []struct {
			Configured bool `json:"api_key_configured"`
		} `json:"keys"`
	}
	if json.Unmarshal(saved, &view) != nil || view.At != 210 || len(view.Keys) != 1 || !view.Keys[0].Configured || strings.Contains(string(saved), "qa-test-key") {
		t.Fatalf("invalid safe config view: %s", saved)
	}
	keep := strings.Replace(body, `"api_key":"qa-test-key"`, `"api_key":""`, 1)
	f.want(t, http.MethodPut, path, keep, f.admin, 200)
	readback := f.want(t, http.MethodGet, path, "", f.admin, 200)
	if !strings.Contains(string(readback), `"api_key_configured":true`) {
		t.Fatalf("blank credential lost stored key: %s", readback)
	}
	missing := strings.Replace(keep, "qa-20261027", "qa-other", 1)
	f.want(t, http.MethodPut, path, missing, f.admin, 400)
	f.want(t, http.MethodPut, path, strings.Replace(body, `"enabled":false`, `"enabled":true`, 1), f.admin, 200)
	f.want(t, http.MethodPut, path, strings.Replace(body, `"at_minute":210`, `"at_minute":1440`, 1), f.admin, 400)
	readback = f.want(t, http.MethodGet, path, "", f.admin, 200)
	if !strings.Contains(string(readback), `"client_id":"qa-20261027"`) || strings.Contains(string(readback), "qa-other") {
		t.Fatalf("refused replacement changed keys: %s", readback)
	}
	f.assertClean(t)
}
