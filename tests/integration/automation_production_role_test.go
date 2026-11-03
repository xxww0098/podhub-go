package integration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestAutomationProductionRoleGrants(t *testing.T) {
	f := newAutomationRuntimeFixture(t)
	grant := f.seedGrant(t, 0)
	t.Run("create returns token only after persistence", func(t *testing.T) {
		raw := f.call(t, http.MethodPost, "/api/automation/grants", f.tokens[0], `{"name":"HTTP grant","actions":["read"," prepare ","read"],"expires_in_days":1}`, http.StatusOK)
		var reply struct {
			Data struct {
				Grant struct {
					ID          string
					TokenPrefix string `json:"token_prefix"`
					Actions     []string
					ExpiresAtMS *int64 `json:"expires_at_ms"`
				}
				Token string
			}
		}
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
		if len(reply.Data.Token) != 47 || !strings.HasPrefix(reply.Data.Token, "opa_") || reply.Data.Grant.TokenPrefix != reply.Data.Token[:12] || strings.Join(reply.Data.Grant.Actions, ",") != "read,prepare" || reply.Data.Grant.ExpiresAtMS == nil {
			t.Fatal("invalid persisted grant token or authority shape")
		}
		var stored string
		sum := sha256.Sum256([]byte(reply.Data.Token))
		if err := f.fixture.QueryRow(f.ctx, `SELECT token_hash FROM automation_grants WHERE id=$1::uuid`, reply.Data.Grant.ID).Scan(&stored); err != nil || stored != hex.EncodeToString(sum[:]) {
			t.Fatalf("token was not stored as its digest: %v", err)
		}
		listed := f.call(t, http.MethodGet, "/api/automation/grants", f.tokens[0], "", http.StatusOK)
		if strings.Contains(string(listed), reply.Data.Token) || strings.Contains(string(listed), stored) || strings.Contains(string(listed), `"token":`) || strings.Contains(string(listed), "tokenHash") {
			t.Fatal("list exposed token or token digest")
		}
		f.clean(t)
	})
	t.Run("list and mutations isolate users and organizations", func(t *testing.T) {
		raw := f.call(t, http.MethodGet, "/api/automation/grants", f.tokens[0], "", http.StatusOK)
		if !strings.Contains(string(raw), grant) {
			t.Fatalf("seeded grant missing: %s", raw)
		}
		if raw := f.call(t, http.MethodGet, "/api/automation/grants", f.tokens[1], "", http.StatusOK); string(raw) != `{"data":{"grants":[]}}` {
			t.Fatalf("other organization saw grants: %s", raw)
		}
		f.call(t, http.MethodPost, "/api/automation/grants/"+grant+"/revoke", f.tokens[1], "{}", http.StatusNotFound)
		f.joinOwnerWorkspace(t)
		if raw := f.call(t, http.MethodGet, "/api/automation/grants", f.tokens[1], "", http.StatusOK); string(raw) != `{"data":{"grants":[]}}` {
			t.Fatalf("other member saw grants: %s", raw)
		}
		f.call(t, http.MethodPost, "/api/automation/grants/"+grant+"/revoke", f.tokens[1], "{}", http.StatusNotFound)
		f.clean(t)
	})
	t.Run("revoke dependent rows atomically", func(t *testing.T) {
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO automation_runtimes(org_id,user_id,grant_id,label,renderer_contract) VALUES($1,96311,$2::uuid,'revoke runtime','v1')`, f.orgs[0], grant); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO browser_commands(org_id,user_id,grant_id,client_request_id,action,payload) VALUES($1,96311,$2::uuid,'revoke','listing_prepare','{}')`, f.orgs[0], grant); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO automation_executions(grant_id,execution_id,input_digest,status) VALUES($1::uuid,'00000000-0000-4000-8000-000000000001',repeat('a',64),'completed')`, grant); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO automation_call_receipts(grant_id,execution_id,call_id,method,args_digest,outcome) VALUES($1::uuid,'00000000-0000-4000-8000-000000000001','call','read',repeat('b',64),'ok')`, grant); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `CREATE FUNCTION automation_test_reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected revoke failure'; END $$;
			CREATE TRIGGER automation_test_reject_revoke BEFORE DELETE ON automation_grants FOR EACH ROW EXECUTE FUNCTION automation_test_reject_revoke()`); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodPost, "/api/automation/grants/"+grant+"/revoke", f.tokens[0], "{}", http.StatusInternalServerError)
		for _, table := range []string{"automation_grants", "automation_runtimes", "browser_commands", "automation_executions", "automation_call_receipts"} {
			key := "grant_id"
			if table == "automation_grants" {
				key = "id"
			}
			var count int
			if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM `+table+` WHERE `+key+`=$1::uuid`, grant).Scan(&count); err != nil || count != 1 {
				t.Fatalf("failed revoke changed %s: count=%d err=%v", table, count, err)
			}
		}
		if _, err := f.fixture.Exec(f.ctx, `DROP TRIGGER automation_test_reject_revoke ON automation_grants`); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodPost, "/api/automation/grants/"+grant+"/revoke", f.tokens[0], "{}", http.StatusOK)
		for _, table := range []string{"automation_grants", "automation_runtimes", "browser_commands", "automation_executions", "automation_call_receipts"} {
			key := "grant_id"
			if table == "automation_grants" {
				key = "id"
			}
			var count int
			if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM `+table+` WHERE `+key+`=$1::uuid`, grant).Scan(&count); err != nil || count != 0 {
				t.Fatalf("revoke retained %s: count=%d err=%v", table, count, err)
			}
		}
		f.call(t, http.MethodPost, "/api/automation/grants/"+grant+"/revoke", f.tokens[0], "{}", http.StatusNotFound)
		f.clean(t)
	})
}

func TestAutomationProductionRoleAssetsAndRuntimes(t *testing.T) {
	f := newAutomationRuntimeFixture(t)
	grant, foreignGrant := f.seedGrant(t, 0), f.seedGrant(t, 1)
	register := func(t *testing.T, token, grant, label string) string {
		t.Helper()
		raw := f.call(t, http.MethodPost, "/api/automation/runtimes", token, fmt.Sprintf(`{"grantId":%q,"label":%q,"rendererContract":"browser-v1"}`, grant, label), http.StatusOK)
		var reply struct {
			Data struct {
				Runtime struct{ ID string }
				Lease   int `json:"claim_lease_seconds"`
			}
		}
		if err := json.Unmarshal(raw, &reply); err != nil || reply.Data.Runtime.ID == "" || reply.Data.Lease != 90 {
			t.Fatalf("runtime registration: %s err=%v", raw, err)
		}
		return reply.Data.Runtime.ID
	}
	runtimeID := register(t, f.tokens[0], grant, "owner runtime")
	foreignRuntime := register(t, f.tokens[1], foreignGrant, "foreign runtime")
	t.Run("runtime authority and heartbeat", func(t *testing.T) {
		for i, allowed := range []string{runtimeID, foreignRuntime} {
			raw := f.call(t, http.MethodGet, "/api/automation/runtimes", f.tokens[i], "", http.StatusOK)
			if !strings.Contains(string(raw), allowed) || strings.Contains(string(raw), []string{foreignRuntime, runtimeID}[i]) {
				t.Fatalf("runtime visibility: %s", raw)
			}
		}
		for _, suffix := range []string{"heartbeat", "deregister"} {
			f.call(t, http.MethodPost, "/api/automation/runtimes/"+runtimeID+"/"+suffix, f.tokens[1], "{}", http.StatusNotFound)
		}
		f.call(t, http.MethodPost, "/api/automation/runtimes", f.tokens[1], fmt.Sprintf(`{"grantId":%q,"label":"foreign","rendererContract":"v1"}`, grant), http.StatusNotFound)
		if _, err := f.fixture.Exec(f.ctx, `UPDATE automation_runtimes SET heartbeat_at=clock_timestamp()-interval '2 hours' WHERE id=$1::uuid`, runtimeID); err != nil {
			t.Fatal(err)
		}
		if raw := f.call(t, http.MethodPost, "/api/automation/runtimes/"+runtimeID+"/heartbeat", f.tokens[0], "{}", http.StatusOK); !strings.Contains(string(raw), `"live":true`) {
			t.Fatalf("heartbeat did not restore liveness: %s", raw)
		}
		f.joinOwnerWorkspace(t)
		if raw := f.call(t, http.MethodGet, "/api/automation/runtimes", f.tokens[1], "", http.StatusOK); string(raw) != `{"data":{"runtimes":[]}}` {
			t.Fatalf("same-workspace member saw another user's runtime: %s", raw)
		}
		for _, suffix := range []string{"heartbeat", "deregister"} {
			f.call(t, http.MethodPost, "/api/automation/runtimes/"+runtimeID+"/"+suffix, f.tokens[1], "{}", http.StatusNotFound)
		}
		f.clean(t)
	})
	t.Run("asset persistence input boundaries and isolation", func(t *testing.T) {
		sum := strings.Repeat("A", 64)
		body := fmt.Sprintf(`{"name":"  HTTP assets  ","items":[{"fileName":" one.png ","sha256":%q,"sizeBytes":-3,"runtimeId":%q},{"fileName":"two.png","sha256":%q,"sizeBytes":14}]}`, sum, runtimeID, sum)
		raw := f.call(t, http.MethodPost, "/api/automation/asset-sets", f.tokens[0], body, http.StatusOK)
		var reply struct {
			Data struct {
				Set struct {
					ID, Name string
					Items    []struct {
						FileName, SHA256 string
						SizeBytes        int64
						RuntimeID        *string
					}
				}
			}
		}
		if err := json.Unmarshal(raw, &reply); err != nil || reply.Data.Set.Name != "HTTP assets" || len(reply.Data.Set.Items) != 2 {
			t.Fatalf("asset creation: %s err=%v", raw, err)
		}
		one := reply.Data.Set.Items[0]
		if one.FileName != "one.png" || one.SHA256 != strings.ToLower(sum) || one.SizeBytes != 0 || one.RuntimeID == nil || *one.RuntimeID != runtimeID || reply.Data.Set.Items[1].RuntimeID != nil {
			t.Fatalf("asset normalization: %s", raw)
		}
		if raw := f.call(t, http.MethodGet, "/api/automation/asset-sets", f.tokens[0], "", http.StatusOK); !strings.Contains(string(raw), reply.Data.Set.ID) || !strings.Contains(string(raw), runtimeID) {
			t.Fatalf("asset persistence: %s", raw)
		}
		if raw := f.call(t, http.MethodGet, "/api/automation/asset-sets", f.tokens[1], "", http.StatusOK); string(raw) != `{"data":{"sets":[]}}` {
			t.Fatalf("private asset set leaked: %s", raw)
		}
		foreign := fmt.Sprintf(`{"name":"member assets","items":[{"fileName":"a.png","sha256":%q,"runtimeId":%q}]}`, sum, runtimeID)
		if raw := f.call(t, http.MethodPost, "/api/automation/asset-sets", f.tokens[1], foreign, http.StatusOK); strings.Contains(string(raw), runtimeID) {
			t.Fatalf("foreign runtime associated with another user's asset: %s", raw)
		}
		for _, body := range []string{
			`{"name":"bad","items":null}`, `{"name":"bad","items":[{"fileName":"a","sha256":"no"}]}`,
			fmt.Sprintf(`{"name":"bad","items":[{"fileName":"a","sha256":%q,"sizeBytes":1.5}]}`, sum),
			`{"name":"bad","items":[],"unknown":true}`, `{"name":"bad","items":[]} {}`,
		} {
			f.call(t, http.MethodPost, "/api/automation/asset-sets", f.tokens[0], body, http.StatusBadRequest)
		}
		if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE automation_asset_set_items ADD CONSTRAINT automation_test_reject_item CHECK (file_name <> 'reject.png')`); err != nil {
			t.Fatal(err)
		}
		failed := fmt.Sprintf(`{"name":"rollback assets","items":[{"fileName":"first.png","sha256":%q},{"fileName":"reject.png","sha256":%q}]}`, sum, sum)
		f.call(t, http.MethodPost, "/api/automation/asset-sets", f.tokens[0], failed, http.StatusInternalServerError)
		var sets int
		if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM automation_asset_sets WHERE name='rollback assets'`).Scan(&sets); err != nil || sets != 0 {
			t.Fatalf("failed second item retained its set: count=%d err=%v", sets, err)
		}
		f.clean(t)
	})
	t.Run("deregister release rolls back with runtime", func(t *testing.T) {
		var command string
		if err := f.fixture.QueryRow(f.ctx, `INSERT INTO browser_commands(org_id,user_id,grant_id,client_request_id,action,payload,status,claimed_by,claim_epoch,claim_expires_at)
			VALUES($1,96311,$2::uuid,'release','listing_prepare','{}','claimed',$3::uuid,1,clock_timestamp()+interval '90 seconds') RETURNING id::text`, f.orgs[0], grant, runtimeID).Scan(&command); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `CREATE FUNCTION automation_test_reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected release failure'; END $$;
			CREATE TRIGGER automation_test_reject_release BEFORE UPDATE ON browser_commands FOR EACH ROW EXECUTE FUNCTION automation_test_reject_release()`); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodPost, "/api/automation/runtimes/"+runtimeID+"/deregister", f.tokens[0], "{}", http.StatusInternalServerError)
		var registered bool
		var status string
		if err := f.fixture.QueryRow(f.ctx, `SELECT r.deregistered_at IS NULL,c.status FROM automation_runtimes r JOIN browser_commands c ON c.claimed_by=r.id WHERE c.id=$1::uuid`, command).Scan(&registered, &status); err != nil || !registered || status != "claimed" {
			t.Fatalf("partial deregistration: registered=%v status=%s err=%v", registered, status, err)
		}
		if _, err := f.fixture.Exec(f.ctx, `DROP TRIGGER automation_test_reject_release ON browser_commands`); err != nil {
			t.Fatal(err)
		}
		f.call(t, http.MethodPost, "/api/automation/runtimes/"+runtimeID+"/deregister", f.tokens[0], "{}", http.StatusOK)
		var released bool
		if err := f.fixture.QueryRow(f.ctx, `SELECT status='queued' AND claimed_by IS NULL AND claim_expires_at IS NULL FROM browser_commands WHERE id=$1::uuid`, command).Scan(&released); err != nil || !released {
			t.Fatalf("command was not released: %v err=%v", released, err)
		}
		for _, suffix := range []string{"heartbeat", "deregister"} {
			f.call(t, http.MethodPost, "/api/automation/runtimes/"+runtimeID+"/"+suffix, f.tokens[0], "{}", http.StatusNotFound)
		}
		if raw := f.call(t, http.MethodGet, "/api/automation/runtimes", f.tokens[0], "", http.StatusOK); strings.Contains(string(raw), runtimeID) {
			t.Fatalf("stopped runtime remains listed: %s", raw)
		}
		f.clean(t)
	})
}

func TestAutomationProductionRoleRefusals(t *testing.T) {
	f := newAutomationRuntimeFixture(t)
	grant := f.seedGrant(t, 0)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE automation_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, grant); err != nil {
		t.Fatal(err)
	}
	f.call(t, http.MethodPost, "/api/automation/runtimes", f.tokens[0], fmt.Sprintf(`{"grantId":%q,"label":"expired","rendererContract":"v1"}`, grant), http.StatusNotFound)
	for _, tc := range []struct{ path, body string }{
		{"grants", `{"name":"empty actions","actions":[]}`},
		{"grants", `{"name":"unknown action","actions":["unknown"]}`},
		{"grants", `{"name":"expiry","actions":["read"],"expires_in_days":0}`},
		{"grants", `{"name":"scope","actions":["supplier:read"]}`},
		{"runtimes", fmt.Sprintf(`{"grantId":%q,"label":" ","rendererContract":"v1"}`, grant)},
		{"runtimes", fmt.Sprintf(`{"grantId":%q,"label":"bad renderer","rendererContract":%q}`, grant, strings.Repeat("v", 65))},
	} {
		f.call(t, http.MethodPost, "/api/automation/"+tc.path, f.tokens[0], tc.body, http.StatusBadRequest)
	}
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE automation_grants ADD CONSTRAINT automation_test_reject_grant CHECK (name <> 'reject grant')`); err != nil {
		t.Fatal(err)
	}
	raw := f.call(t, http.MethodPost, "/api/automation/grants", f.tokens[0], `{"name":"reject grant","actions":["read"]}`, http.StatusInternalServerError)
	if strings.Contains(string(raw), "opa_") || strings.Contains(string(raw), `"token"`) {
		t.Fatal("failed grant creation returned a token")
	}
	var count int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM automation_grants WHERE name='reject grant'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed grant persisted: count=%d err=%v", count, err)
	}
	routes := []struct{ method, path, body string }{
		{http.MethodGet, "asset-sets", ""},
		{http.MethodPost, "asset-sets", `{"name":"private","items":[]}`},
		{http.MethodGet, "grants", ""},
		{http.MethodPost, "grants", `{"name":"private","actions":["read"]}`},
		{http.MethodPost, "grants/" + grant + "/revoke", "{}"},
		{http.MethodGet, "runtimes", ""},
		{http.MethodPost, "runtimes", fmt.Sprintf(`{"grantId":%q,"label":"private","rendererContract":"v1"}`, grant)},
		{http.MethodPost, "runtimes/00000000-0000-4000-8000-000000000001/heartbeat", "{}"},
		{http.MethodPost, "runtimes/00000000-0000-4000-8000-000000000001/deregister", "{}"},
	}
	for _, route := range routes {
		f.call(t, route.method, "/api/automation/"+route.path, "", route.body, http.StatusUnauthorized)
	}
	f.call(t, http.MethodPost, "/api/auth/logout", f.tokens[0], "{}", http.StatusNoContent)
	for _, route := range routes {
		f.call(t, route.method, "/api/automation/"+route.path, f.tokens[0], route.body, http.StatusUnauthorized)
	}
	f.clean(t)
}

type automationRuntimeFixture struct {
	identityRuntimeFixture
	server *httptest.Server
	tokens [2]string
	orgs   [2]int64
}

func newAutomationRuntimeFixture(t *testing.T) automationRuntimeFixture {
	t.Helper()
	f := automationRuntimeFixture{identityRuntimeFixture: newIdentityRuntimeFixture(t)}
	f.server = httptest.NewServer(f.handler)
	t.Cleanup(f.server.Close)
	var count int
	var denied *pgconn.PgError
	if err := f.runtime.QueryRow(f.ctx, `SELECT count(*) FROM automation_grants`).Scan(&count); !errors.As(err, &denied) || denied.Code != "42501" {
		t.Fatalf("bare login unexpectedly read grants: count=%d err=%v", count, err)
	}
	for i, user := range []int64{96311, 96312} {
		if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=$1`, user).Scan(&f.orgs[i]); err != nil {
			t.Fatal(err)
		}
		raw := f.call(t, http.MethodPost, "/api/auth/login", "", fmt.Sprintf(`{"email":"a%d@example.invalid","password":"original-password"}`, user), http.StatusOK)
		var reply struct{ Data struct{ Token string } }
		if err := json.Unmarshal(raw, &reply); err != nil || reply.Data.Token == "" {
			t.Fatalf("real HTTP login: %v", err)
		}
		f.tokens[i] = reply.Data.Token
	}
	return f
}

func (f automationRuntimeFixture) call(t *testing.T, method, path, token, body string, want int) []byte {
	t.Helper()
	r, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, strings.NewReader(body))
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
	if err != nil || response.StatusCode != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s err=%v", method, path, response.StatusCode, want, raw, err)
	}
	return raw
}

func (f automationRuntimeFixture) seedGrant(t *testing.T, user int) string {
	t.Helper()
	var id string
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO automation_grants(user_id,org_id,name,token_hash,token_prefix,actions) VALUES($1,$2,'fixture grant',gen_random_uuid()::text,'fixture',ARRAY['read','prepare']) RETURNING id::text`, int64(96311+user), f.orgs[user]).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f automationRuntimeFixture) joinOwnerWorkspace(t *testing.T) {
	t.Helper()
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO organization_members(org_id,user_id,role,status,display_name,join_order,created_at,updated_at) VALUES($1,96312,'member','active','Other member',2,clock_timestamp(),clock_timestamp())`, f.orgs[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET active_org_id=$1 WHERE id=96312`, f.orgs[0]); err != nil {
		t.Fatal(err)
	}
}

func (f automationRuntimeFixture) clean(t *testing.T) {
	t.Helper()
	f.assertClean(t)
	var grant string
	if err := f.runtime.QueryRow(f.ctx, `SELECT COALESCE(current_setting('app.automation_grant_id',true),'')`).Scan(&grant); err != nil || grant != "" {
		t.Fatalf("grant session setting leaked: %q err=%v", grant, err)
	}
}
