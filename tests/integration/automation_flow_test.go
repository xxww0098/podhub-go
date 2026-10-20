package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	automationhttp "github.com/xxww0098/podhub-go/internal/automation/http"
	automationrepo "github.com/xxww0098/podhub-go/internal/automation/repo"
	automationsvc "github.com/xxww0098/podhub-go/internal/automation/service"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestAutomationFlow(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	userA, orgA := seedAutomationOwner(t, ctx, pool, "auto-a")
	userB, orgB := seedAutomationOwner(t, ctx, pool, "auto-b")
	member := seedAutomationMember(t, ctx, pool, orgA, "auto-member")
	t.Cleanup(func() {
		cctx := context.Background()
		_, _ = pool.Exec(cctx, `DELETE FROM automation_call_receipts WHERE grant_id IN (SELECT id FROM automation_grants WHERE name LIKE 'auto-%')`)
		_, _ = pool.Exec(cctx, `DELETE FROM automation_executions WHERE grant_id IN (SELECT id FROM automation_grants WHERE name LIKE 'auto-%')`)
		_, _ = pool.Exec(cctx, `DELETE FROM browser_commands WHERE client_request_id LIKE 'auto-%'`)
		_, _ = pool.Exec(cctx, `DELETE FROM automation_asset_set_items WHERE set_id IN (SELECT id FROM automation_asset_sets WHERE name LIKE 'auto-%' OR name IN ('demo','sku images','legacy images','empty','trimmed'))`)
		_, _ = pool.Exec(cctx, `DELETE FROM automation_asset_sets WHERE org_id IN ($1,$2)`, orgA, orgB)
		_, _ = pool.Exec(cctx, `DELETE FROM automation_runtimes WHERE org_id IN ($1,$2)`, orgA, orgB)
		_, _ = pool.Exec(cctx, `DELETE FROM automation_grants WHERE org_id IN ($1,$2)`, orgA, orgB)
	})

	who := &automationCaller{user: userA, org: orgA, role: "owner"}
	r := chi.NewRouter()
	automationhttp.Mount(r, automationhttp.Deps{
		Resolve: who.resolve,
		Actions: automationsvc.New(automationrepo.New(pool, tenant.BeginApp), nil, nil),
	})
	api := func(method, path, body string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if method != http.MethodGet {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		raw, _ := io.ReadAll(rec.Body)
		return rec.Code, raw
	}

	t.Run("grant lifecycle", func(t *testing.T) {
		code, raw := api(http.MethodPost, "/api/automation/grants", `{"name":"auto-ci agent","actions":["read"]}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		var created struct {
			Data struct {
				Grant map[string]any `json:"grant"`
				Token string         `json:"token"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &created); err != nil {
			t.Fatal(err)
		}
		token := created.Data.Token
		if !strings.HasPrefix(token, "opa_") || len(token) != 47 {
			t.Fatal(token)
		}
		if _, ok := created.Data.Grant["token"]; ok {
			t.Fatal("grant view leaked token")
		}
		if created.Data.Grant["tokenPrefix"] != token[:12] {
			t.Fatalf("%v", created.Data.Grant["tokenPrefix"])
		}
		grantID, _ := created.Data.Grant["id"].(string)
		sum := sha256.Sum256([]byte(token))
		var stored string
		if err := pool.QueryRow(ctx, `SELECT token_hash FROM automation_grants WHERE id=$1::uuid`, grantID).Scan(&stored); err != nil || stored != hex.EncodeToString(sum[:]) {
			t.Fatalf("hash %s %v", stored, err)
		}
		code, raw = api(http.MethodGet, "/api/automation/grants", "")
		if code != 200 || !strings.Contains(string(raw), `"id":"`+grantID+`"`) || strings.Contains(string(raw), `"token":`) {
			t.Fatalf("%d %s", code, raw)
		}
		code, raw = api(http.MethodPost, "/api/automation/grants/"+grantID+"/revoke", "")
		if code != 200 || string(raw) != `{"data":{"id":"`+grantID+`","revoked":true}}` {
			t.Fatalf("%d %s", code, raw)
		}
		code, raw = api(http.MethodGet, "/api/automation/grants", "")
		if code != 200 || string(raw) != `{"data":{"grants":[]}}` {
			t.Fatalf("%d %s", code, raw)
		}
		code, _ = api(http.MethodPost, "/api/automation/grants/"+grantID+"/revoke", "")
		if code != 404 {
			t.Fatal(code)
		}
	})

	t.Run("member actions and authority", func(t *testing.T) {
		who.user, who.role = member, "member"
		code, raw := api(http.MethodPost, "/api/automation/grants", `{"name":"auto-member agent","actions":["read","prepare"]}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		code, raw = api(http.MethodPost, "/api/automation/grants", `{"name":"auto-bad","actions":["bogus"]}`)
		if code != 400 {
			t.Fatalf("%d %s", code, raw)
		}
		if _, err := pool.Exec(ctx, `UPDATE organization_members SET manual_disabled = true WHERE user_id=$1 AND org_id=$2`, member, orgA); err != nil {
			t.Fatal(err)
		}
		code, raw = api(http.MethodPost, "/api/automation/grants", `{"name":"auto-fenced","actions":["read"]}`)
		if code != 403 || string(raw) != `{"error":"当前授权已变化，请刷新后重试","code":"FORBIDDEN"}` {
			t.Fatalf("%d %s", code, raw)
		}
		if _, err := pool.Exec(ctx, `UPDATE organization_members SET manual_disabled = false WHERE user_id=$1 AND org_id=$2`, member, orgA); err != nil {
			t.Fatal(err)
		}
		who.user, who.role = userA, "owner"
	})

	var grantID, runtimeA, runtimeB string
	t.Run("runtime register list heartbeat", func(t *testing.T) {
		code, raw := api(http.MethodPost, "/api/automation/grants", `{"name":"auto-runtime","actions":["read","prepare"],"expiresInDays":1}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		var created struct {
			Data struct {
				Grant struct {
					ID          string `json:"id"`
					ExpiresAtMS *int64 `json:"expiresAtMs"`
				} `json:"grant"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &created); err != nil {
			t.Fatal(err)
		}
		if created.Data.Grant.ExpiresAtMS == nil {
			t.Fatal("missing expiry")
		}
		grantID = created.Data.Grant.ID
		code, raw = api(http.MethodPost, "/api/automation/runtimes", `{"grantId":"`+grantID+`","label":"tab A","rendererContract":"render-v1"}`)
		if code != 200 || !strings.Contains(string(raw), `"claim_lease_seconds":90`) || !strings.Contains(string(raw), `"live":true`) {
			t.Fatalf("%d %s", code, raw)
		}
		var reg struct {
			Data struct {
				Runtime struct {
					ID string `json:"id"`
				} `json:"runtime"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &reg); err != nil {
			t.Fatal(err)
		}
		runtimeA = reg.Data.Runtime.ID
		code, raw = api(http.MethodPost, "/api/automation/runtimes", `{"grantId":"`+grantID+`","label":"tab B","rendererContract":"render-v1"}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		if err := json.Unmarshal(raw, &reg); err != nil {
			t.Fatal(err)
		}
		runtimeB = reg.Data.Runtime.ID
		if _, err := pool.Exec(ctx, `UPDATE automation_runtimes SET heartbeat_at = clock_timestamp() - interval '2 hours' WHERE id=$1::uuid`, runtimeA); err != nil {
			t.Fatal(err)
		}
		code, raw = api(http.MethodPost, "/api/automation/runtimes/"+runtimeA+"/heartbeat", `{}`)
		if code != 200 || !strings.Contains(string(raw), `"live":true`) {
			t.Fatalf("%d %s", code, raw)
		}
		code, raw = api(http.MethodGet, "/api/automation/runtimes", "")
		if code != 200 || !strings.Contains(string(raw), runtimeA) || !strings.Contains(string(raw), runtimeB) {
			t.Fatalf("%d %s", code, raw)
		}
		who.user = userB
		code, raw = api(http.MethodPost, "/api/automation/runtimes/"+runtimeA+"/heartbeat", `{}`)
		if code != 404 || string(raw) != `{"error":"执行端不存在或已注销","code":"NOT_FOUND"}` {
			t.Fatalf("%d %s", code, raw)
		}
		who.user = userA
	})

	t.Run("lease renew progress settle", func(t *testing.T) {
		var command string
		if err := pool.QueryRow(ctx, `
			INSERT INTO browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
			VALUES ($1,$2,$3::uuid,'auto-req-1','listing_prepare','{"rowIds":["row-1"]}'::jsonb)
			RETURNING id::text`, orgA, userA, grantID).Scan(&command); err != nil {
			t.Fatal(err)
		}
		code, raw := api(http.MethodPost, "/api/automation/commands/claim", `{"runtimeId":"`+runtimeA+`","limit":1}`)
		if code != 200 || !strings.Contains(string(raw), `"operationId":"`+command+`"`) || !strings.Contains(string(raw), `"lease_seconds":90`) || !strings.Contains(string(raw), `"claimEpoch":1`) {
			t.Fatalf("%d %s", code, raw)
		}
		if !strings.Contains(string(raw), `"payload":{"rowIds":["row-1"]}`) {
			t.Fatalf("payload %s", raw)
		}
		var extended bool
		if err := pool.QueryRow(ctx, `SELECT (claim_expires_at - clock_timestamp()) > interval '80 seconds' FROM browser_commands WHERE id=$1::uuid`, command).Scan(&extended); err != nil || !extended {
			t.Fatalf("extended %v %v", extended, err)
		}
		renew := func(runtime string, epoch int) (int, string) {
			t.Helper()
			code, raw := api(http.MethodPost, "/api/automation/commands/renew", `{"runtimeId":"`+runtime+`","claims":[{"operationId":"`+command+`","claimEpoch":`+strconv.Itoa(epoch)+`}]}`)
			return code, string(raw)
		}
		code, body := renew(runtimeA, 1)
		if code != 200 || !strings.Contains(body, `"control":"continue"`) || !strings.Contains(body, `"leaseSeconds":90`) {
			t.Fatalf("%d %s", code, body)
		}
		code, body = renew(runtimeB, 1)
		if code != 200 || !strings.Contains(body, `"control":"lost"`) || !strings.Contains(body, `"leaseSeconds":0`) {
			t.Fatalf("%d %s", code, body)
		}
		code, body = renew(runtimeA, 2)
		if !strings.Contains(body, `"control":"lost"`) {
			t.Fatalf("%d %s", code, body)
		}
		code, raw = api(http.MethodPost, "/api/automation/commands/"+command+"/progress", `{"claimEpoch":1,"progress":{"done":1}}`)
		if code != 200 || string(raw) != `{"data":{"accepted":true,"cancelRequested":false}}` {
			t.Fatalf("%d %s", code, raw)
		}
		var progress string
		if err := pool.QueryRow(ctx, `SELECT progress::text FROM browser_commands WHERE id=$1::uuid`, command).Scan(&progress); err != nil || progress != `{"done": 1}` {
			t.Fatalf("progress %s %v", progress, err)
		}
		if _, err := pool.Exec(ctx, `UPDATE browser_commands SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1::uuid`, command); err != nil {
			t.Fatal(err)
		}
		code, body = renew(runtimeA, 1)
		if !strings.Contains(body, `"control":"lost"`) {
			t.Fatal(body)
		}
		code, raw = api(http.MethodPost, "/api/automation/commands/"+command+"/progress", `{"claimEpoch":1,"progress":{}}`)
		if string(raw) != `{"data":{"accepted":false,"cancelRequested":true}}` {
			t.Fatalf("%d %s", code, raw)
		}
		code, raw = api(http.MethodPost, "/api/automation/commands/"+command+"/settle", `{"claimEpoch":1,"status":"completed"}`)
		if string(raw) != `{"data":{"accepted":false,"cancelRequested":true}}` {
			t.Fatalf("%d %s", code, raw)
		}
		if _, err := pool.Exec(ctx, `UPDATE browser_commands SET claim_expires_at = clock_timestamp() + interval '90 seconds', cancel_requested_at = clock_timestamp() WHERE id=$1::uuid`, command); err != nil {
			t.Fatal(err)
		}
		code, body = renew(runtimeA, 1)
		if !strings.Contains(body, `"control":"cancel"`) || !strings.Contains(body, `"leaseSeconds":90`) {
			t.Fatalf("%d %s", code, body)
		}
		code, raw = api(http.MethodPost, "/api/automation/commands/"+command+"/settle", `{"claimEpoch":1,"status":"completed","result":{"ok":true}}`)
		if string(raw) != `{"data":{"accepted":true,"cancelRequested":true}}` {
			t.Fatalf("%d %s", code, raw)
		}
		var status string
		var expiresNull, claimed bool
		var epoch int64
		if err := pool.QueryRow(ctx, `SELECT status, claim_expires_at IS NULL, claimed_by IS NOT NULL, claim_epoch FROM browser_commands WHERE id=$1::uuid`, command).Scan(&status, &expiresNull, &claimed, &epoch); err != nil {
			t.Fatal(err)
		}
		if status != "completed" || !expiresNull || !claimed || epoch != 1 {
			t.Fatalf("%s null=%v claimed=%v epoch=%d", status, expiresNull, claimed, epoch)
		}
		code, raw = api(http.MethodPost, "/api/automation/commands/"+command+"/settle", `{"claimEpoch":1,"status":"failed"}`)
		if string(raw) != `{"data":{"accepted":false,"cancelRequested":true}}` {
			t.Fatalf("replay %d %s", code, raw)
		}
		var still string
		if err := pool.QueryRow(ctx, `SELECT status FROM browser_commands WHERE id=$1::uuid`, command).Scan(&still); err != nil || still != "completed" {
			t.Fatal(still)
		}
	})

	t.Run("asset wait and legacy label", func(t *testing.T) {
		code, raw := api(http.MethodPost, "/api/automation/grants", `{"name":"auto-second grant","actions":["prepare"]}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		var created struct {
			Data struct {
				Grant struct {
					ID string `json:"id"`
				} `json:"grant"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &created); err != nil {
			t.Fatal(err)
		}
		grantTwo := created.Data.Grant.ID
		tab := "tab 1:00000000-0000-0000-0000-000000000001"
		other := "tab 1:00000000-0000-0000-0000-000000000002"
		reg := func(grant, label string) string {
			t.Helper()
			code, raw := api(http.MethodPost, "/api/automation/runtimes", `{"grantId":"`+grant+`","label":"`+label+`","rendererContract":"render-v1"}`)
			if code != 200 {
				t.Fatalf("%d %s", code, raw)
			}
			var out struct {
				Data struct {
					Runtime struct {
						ID string `json:"id"`
					} `json:"runtime"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatal(err)
			}
			return out.Data.Runtime.ID
		}
		hold := reg(grantID, tab)
		same := reg(grantTwo, tab)
		otherRT := reg(grantTwo, other)
		sha := strings.Repeat("a", 64)
		code, raw = api(http.MethodPost, "/api/automation/asset-sets", `{"name":"sku images","items":[{"fileName":"a.jpg","sha256":"`+sha+`","sizeBytes":3,"runtimeId":"`+hold+`"}]}`)
		if code != 200 || !strings.Contains(string(raw), `"runtimeId":"`+hold+`"`) {
			t.Fatalf("%d %s", code, raw)
		}
		var set struct {
			Data struct {
				Set struct {
					ID string `json:"id"`
				} `json:"set"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &set); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
			VALUES ($1,$2,$3::uuid,'auto-assets','assets_import', jsonb_build_object('assetSetId',$4::text))`,
			orgA, userA, grantTwo, set.Data.Set.ID); err != nil {
			t.Fatal(err)
		}
		claimN := func(runtime string) int {
			t.Helper()
			code, raw := api(http.MethodPost, "/api/automation/commands/claim", `{"runtimeId":"`+runtime+`","limit":1}`)
			if code != 200 {
				t.Fatalf("%d %s", code, raw)
			}
			var body struct {
				Data struct {
					Commands []any `json:"commands"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			return len(body.Data.Commands)
		}
		if claimN(otherRT) != 0 || claimN(same) != 1 {
			t.Fatal("asset wait")
		}
		for _, id := range []string{hold, same} {
			code, raw = api(http.MethodPost, "/api/automation/runtimes/"+id+"/deregister", `{}`)
			if code != 200 {
				t.Fatalf("deregister %d %s", code, raw)
			}
		}
		if claimN(otherRT) != 1 {
			t.Fatal("reclaim")
		}
		code, raw = api(http.MethodPost, "/api/automation/runtimes/"+hold+"/deregister", `{}`)
		if code != 404 || string(raw) != `{"error":"执行端不存在或已注销","code":"NOT_FOUND"}` {
			t.Fatalf("%d %s", code, raw)
		}

		legacyA := reg(grantID, "tab 1")
		legacyB := reg(grantID, "tab 1")
		code, raw = api(http.MethodPost, "/api/automation/asset-sets", `{"name":"legacy images","items":[{"fileName":"a.jpg","sha256":"`+sha+`","sizeBytes":3,"runtimeId":"`+legacyA+`"}]}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		if err := json.Unmarshal(raw, &set); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
			VALUES ($1,$2,$3::uuid,'auto-legacy','assets_import', jsonb_build_object('assetSetId',$4::text))`,
			orgA, userA, grantID, set.Data.Set.ID); err != nil {
			t.Fatal(err)
		}
		if claimN(legacyB) != 0 {
			t.Fatal("legacy label shared")
		}
	})

	t.Run("asset set rules", func(t *testing.T) {
		sha := strings.Repeat("b", 64)
		code, raw := api(http.MethodPost, "/api/automation/asset-sets", `{"name":"  trimmed  ","items":[]}`)
		if code != 200 || !strings.Contains(string(raw), `"name":"trimmed"`) || !strings.Contains(string(raw), `"items":[]`) {
			t.Fatalf("%d %s", code, raw)
		}
		code, raw = api(http.MethodPost, "/api/automation/asset-sets", `{"name":"trimmed","items":[]}`)
		if code != 500 || string(raw) != `{"error":"服务暂不可用","code":"INTERNAL"}` {
			t.Fatalf("%d %s", code, raw)
		}
		body := `{"name":"auto-dup","items":[{"fileName":"a.jpg","sha256":"` + sha + `","sizeBytes":1},{"fileName":"a.jpg","sha256":"` + sha + `","sizeBytes":9,"runtimeId":"not-a-uuid"}]}`
		code, raw = api(http.MethodPost, "/api/automation/asset-sets", body)
		if code != 500 {
			t.Fatalf("bad runtime uuid %d %s", code, raw)
		}
		var sets int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM automation_asset_sets WHERE org_id=$1 AND name='auto-dup'`, orgA).Scan(&sets); err != nil || sets != 0 {
			t.Fatalf("rolled back %d %v", sets, err)
		}
		body = `{"name":"auto-dup","items":[{"fileName":"a.jpg","sha256":"` + sha + `","sizeBytes":1},{"fileName":"a.jpg","sha256":"` + sha + `","sizeBytes":9}]}`
		code, raw = api(http.MethodPost, "/api/automation/asset-sets", body)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM automation_asset_set_items i JOIN automation_asset_sets s ON s.id=i.set_id WHERE s.name='auto-dup' AND s.org_id=$1`, orgA).Scan(&n); err != nil || n != 1 {
			t.Fatalf("items %d %v", n, err)
		}
		var size int64
		if err := pool.QueryRow(ctx, `SELECT i.size_bytes FROM automation_asset_set_items i JOIN automation_asset_sets s ON s.id=i.set_id WHERE s.name='auto-dup'`).Scan(&size); err != nil || size != 9 {
			t.Fatalf("size %d %v", size, err)
		}
		code, raw = api(http.MethodGet, "/api/automation/asset-sets", "")
		if code != 200 || !strings.Contains(string(raw), `"name":"auto-dup"`) {
			t.Fatalf("%d %s", code, raw)
		}
		who.user = userB
		code, raw = api(http.MethodGet, "/api/automation/asset-sets", "")
		if code != 200 || strings.Contains(string(raw), "auto-dup") {
			t.Fatalf("cross user %d %s", code, raw)
		}
		who.user = userA
	})

	t.Run("revoke deletes dependents", func(t *testing.T) {
		code, raw := api(http.MethodPost, "/api/automation/grants", `{"name":"auto-gone","actions":["read","prepare"]}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		var created struct {
			Data struct {
				Grant struct {
					ID string `json:"id"`
				} `json:"grant"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &created); err != nil {
			t.Fatal(err)
		}
		id := created.Data.Grant.ID
		code, raw = api(http.MethodPost, "/api/automation/runtimes", `{"grantId":"`+id+`","label":"ci tab","rendererContract":"psd-x@1"}`)
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		var execID string
		if err := pool.QueryRow(ctx, `
			INSERT INTO automation_executions (grant_id, execution_id, input_digest, lease_token, lease_deadline)
			VALUES ($1::uuid, gen_random_uuid(), repeat('a', 64), gen_random_uuid(), clock_timestamp() + interval '1 minute')
			RETURNING execution_id::text`, id).Scan(&execID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO automation_call_receipts (grant_id, execution_id, call_id, method, args_digest, outcome)
			VALUES ($1::uuid, $2::uuid, 'c1', 'search', repeat('b', 64), 'ok')`, id, execID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO browser_commands (org_id, user_id, grant_id, client_request_id, action, payload)
			VALUES ($1,$2,$3::uuid,'auto-gone','listing_prepare','{}'::jsonb)`, orgA, userA, id); err != nil {
			t.Fatal(err)
		}
		code, raw = api(http.MethodPost, "/api/automation/grants/"+id+"/revoke", "")
		if code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		for _, q := range []string{
			`SELECT count(*) FROM automation_grants WHERE id=$1::uuid`,
			`SELECT count(*) FROM automation_runtimes WHERE grant_id=$1::uuid`,
			`SELECT count(*) FROM browser_commands WHERE grant_id=$1::uuid`,
			`SELECT count(*) FROM automation_executions WHERE grant_id=$1::uuid`,
			`SELECT count(*) FROM automation_call_receipts WHERE grant_id=$1::uuid`,
		} {
			var n int
			if err := pool.QueryRow(ctx, q, id).Scan(&n); err != nil || n != 0 {
				t.Fatalf("%s n=%d %v", q, n, err)
			}
		}
	})

	t.Run("rls", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO automation_asset_sets (org_id, user_id, name) VALUES ($1,$2,'auto-rls-a'), ($3,$4,'auto-rls-b')`,
			orgA, userA, orgB, userB); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO automation_runtimes (org_id, user_id, grant_id, label, renderer_contract)
			SELECT $1, $2, id, 'auto-rls', 'v' FROM automation_grants WHERE org_id=$1 LIMIT 1`, orgA, userA); err != nil {
			t.Fatal(err)
		}
		txB, err := tenant.BeginApp(ctx, pool.Begin, orgB)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = txB.Rollback(ctx) }()
		var n int
		if err := txB.QueryRow(ctx, `SELECT count(*) FROM automation_asset_sets WHERE name LIKE 'auto-rls-%'`).Scan(&n); err != nil || n != 1 {
			t.Fatalf("org B sets %d %v", n, err)
		}
		tag, err := txB.Exec(ctx, `UPDATE automation_asset_sets SET name='stolen' WHERE org_id=$1`, orgA)
		if err != nil || tag.RowsAffected() != 0 {
			t.Fatalf("cross update %v", err)
		}
		if err := txB.QueryRow(ctx, `SELECT count(*) FROM automation_runtimes WHERE label='auto-rls'`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("org B runtimes %d %v", n, err)
		}
		if _, err := txB.Exec(ctx, `SAVEPOINT cross_insert`); err != nil {
			t.Fatal(err)
		}
		_, err = txB.Exec(ctx, `INSERT INTO automation_asset_sets (org_id, user_id, name) VALUES ($1,$2,'auto-cross')`, orgA, userA)
		if err == nil {
			t.Fatal("cross insert")
		}
		if _, err := txB.Exec(ctx, `ROLLBACK TO SAVEPOINT cross_insert`); err != nil {
			t.Fatal(err)
		}

		bare, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = bare.Rollback(ctx) }()
		if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		if err := bare.QueryRow(ctx, `SELECT count(*) FROM automation_asset_sets WHERE name LIKE 'auto-rls-%'`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("missing guc %d %v", n, err)
		}
		if err := bare.QueryRow(ctx, `SELECT count(*) FROM automation_runtimes WHERE label='auto-rls'`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("runtime missing guc %d %v", n, err)
		}
		if _, err := bare.Exec(ctx, `SAVEPOINT noguc`); err != nil {
			t.Fatal(err)
		}
		_, err = bare.Exec(ctx, `INSERT INTO automation_asset_sets (org_id, user_id, name) VALUES ($1,$2,'auto-noguc')`, orgA, userA)
		if err == nil {
			t.Fatal("missing guc insert")
		}
		if _, err := bare.Exec(ctx, `ROLLBACK TO SAVEPOINT noguc`); err != nil {
			t.Fatal(err)
		}
	})
}

type automationCaller struct {
	user int64
	org  int64
	role string
}

func (c *automationCaller) resolve(*http.Request) (*automationhttp.Session, *automationhttp.Refusal, error) {
	return &automationhttp.Session{UserID: c.user, OrgID: c.org, WorkspaceRole: c.role}, nil, nil
}

func seedAutomationOwner(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) (int64, int64) {
	t.Helper()
	email := tag + "-" + uuid.NewString() + "@example.invalid"
	var userID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO account_users (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1,$2,'x','user',$3,'/workspace','','lite', clock_timestamp(), clock_timestamp())
		RETURNING id`, email, email, tag).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1,$2,'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, userID, tag+"-"+email).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1,$2,'owner','active',$3, clock_timestamp(), clock_timestamp(), 1)`, orgID, userID, tag); err != nil {
		t.Fatal(err)
	}
	return userID, orgID
}

func seedAutomationMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, tag string) int64 {
	t.Helper()
	email := tag + "-" + uuid.NewString() + "@example.invalid"
	var userID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO account_users (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1,$2,'x','user',$3,'/workspace','','lite', clock_timestamp(), clock_timestamp())
		RETURNING id`, email, email, tag).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1,$2,'member','active',$3, clock_timestamp(), clock_timestamp(), 2)`, orgID, userID, tag); err != nil {
		t.Fatal(err)
	}
	return userID
}
