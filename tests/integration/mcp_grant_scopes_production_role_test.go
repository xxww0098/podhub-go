package integration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	mcprepo "github.com/xxww0098/podhub-go/internal/mcp/repo"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestMCPGrantScopesProductionRole(t *testing.T) {
	f := newAdminContentFixture(t)
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	const catalog = "/api/me/catalog-automation/grants"
	const workspace = "/api/automation/grants"
	const supplier = "/api/admin/supplier-automation/grants"
	const initialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	create := func(path, session, body string) (string, string) {
		t.Helper()
		raw := f.want(t, http.MethodPost, path, body, session, http.StatusOK)
		if err := spec.CheckResponse(http.MethodPost, path, http.StatusOK, http.Header{"Content-Type": {"application/json"}}, raw); err != nil {
			t.Fatal(err)
		}
		var result struct {
			Data struct {
				Grant struct {
					ID          string
					Prefix      string `json:"token_prefix"`
					ExpiresAtMS *int64 `json:"expires_at_ms"`
				}
				Token string
			}
		}
		if err := json.Unmarshal(raw, &result); err != nil || len(result.Data.Token) != 47 || result.Data.Grant.Prefix != result.Data.Token[:12] || result.Data.Grant.ExpiresAtMS == nil {
			t.Fatal("grant create did not return its one-time token, prefix and expiry", err)
		}
		listed := f.want(t, http.MethodGet, path, "", session, http.StatusOK)
		if strings.Contains(string(listed), result.Data.Token) || strings.Contains(string(listed), `"token":`) || !strings.Contains(string(listed), result.Data.Grant.ID) {
			t.Fatal("grant list leaked a token or missed the persisted grant")
		}
		if err := spec.CheckResponse(http.MethodGet, path, http.StatusOK, http.Header{"Content-Type": {"application/json"}}, listed); err != nil {
			t.Fatal(err)
		}
		f.assertClean(t)
		return result.Data.Grant.ID, result.Data.Token
	}
	catalogID, catalogToken := create(catalog, f.user, `{"name":"catalog scope","actions":["catalog:read"],"expires_in_days":1}`)
	f.want(t, http.MethodPost, catalog, `{"name":"bad catalog scope","actions":["read"],"expires_in_days":1}`, f.user, http.StatusBadRequest)
	workspaceID, workspaceToken := create(workspace, f.user, `{"name":"workspace scope","actions":["read"],"expires_in_days":1}`)
	f.want(t, http.MethodPost, workspace+"/"+catalogID+"/revoke", "{}", f.user, http.StatusNotFound)
	f.want(t, http.MethodPost, catalog+"/"+workspaceID+"/revoke", "{}", f.user, http.StatusNotFound)
	f.want(t, http.MethodPost, catalog+"/"+catalogID+"/revoke", "{}", f.admin, http.StatusNotFound)
	if raw := f.want(t, http.MethodGet, catalog, "", f.admin, http.StatusOK); strings.Contains(string(raw), catalogID) {
		t.Fatal("another account read a catalog grant")
	}
	for _, token := range []string{catalogToken, workspaceToken} {
		f.want(t, http.MethodPost, "/mcp", initialize, token, http.StatusOK)
	}
	f.want(t, http.MethodPost, catalog+"/"+catalogID+"/revoke", "{}", f.user, http.StatusOK)
	f.want(t, http.MethodPost, "/mcp", initialize, catalogToken, http.StatusUnauthorized)
	f.want(t, http.MethodPost, workspace+"/"+workspaceID+"/revoke", "{}", f.user, http.StatusOK)
	f.want(t, http.MethodPost, "/mcp", initialize, workspaceToken, http.StatusUnauthorized)
	f.want(t, http.MethodGet, supplier, "", f.user, http.StatusForbidden)
	f.exec(t, `UPDATE account_users SET role='admin' WHERE id=96312`)
	f.exec(t, `INSERT INTO sc_sources(source_id,name,created_at_ms,updated_at_ms) VALUES('grant-scope-source','Grant source',1,1)`)
	for _, source := range []struct {
		json string
		all  bool
		ids  int
	}{{"", false, 0}, {`,"source_ids":[]`, false, 0}, {`,"source_ids":null`, true, 0}, {`,"source_ids":["grant-scope-source"]`, false, 1}} {
		id, token := create(supplier, f.user, `{"name":"supplier scope","actions":["supplier:read"],"expires_in_days":1`+source.json+`}`)
		sum := sha256.Sum256([]byte(token))
		grant, err := mcprepo.New(f.runtime).Resolve(f.ctx, hex.EncodeToString(sum[:]))
		if err != nil || grant == nil || grant.ScopeKind != "supplier_catalog" || grant.OrgID != 0 || grant.SourceAll != source.all || len(grant.SourceIDs) != source.ids {
			t.Fatalf("supplier source authority changed: all=%v ids=%d err=%v", source.all, source.ids, err)
		}
		f.want(t, http.MethodPost, "/mcp", initialize, token, http.StatusOK)
		f.want(t, http.MethodPost, supplier+"/"+id+"/revoke", "{}", f.admin, http.StatusNotFound)
		f.exec(t, `UPDATE account_users SET role='user' WHERE id=96312`)
		f.want(t, http.MethodPost, "/mcp", initialize, token, http.StatusUnauthorized)
		f.want(t, http.MethodGet, supplier, "", f.user, http.StatusForbidden)
		f.exec(t, `UPDATE account_users SET role='admin' WHERE id=96312`)
		f.want(t, http.MethodPost, supplier+"/"+id+"/revoke", "{}", f.user, http.StatusOK)
		f.want(t, http.MethodPost, "/mcp", initialize, token, http.StatusUnauthorized)
		f.assertClean(t)
	}
	f.want(t, http.MethodPost, supplier, `{"name":"bad sources","actions":["supplier:read"],"source_ids":["missing-source"]}`, f.user, http.StatusBadRequest)
	f.exec(t, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=96312`)
	for _, path := range []string{catalog, workspace, supplier} {
		f.want(t, http.MethodGet, path, "", f.user, http.StatusUnauthorized)
	}
	var grants int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM automation_grants WHERE user_id=96312`).Scan(&grants); err != nil || grants != 0 {
		t.Fatal(fmt.Sprintf("revoked grants remaining=%d err=%v", grants, err))
	}
	f.assertClean(t)
}
