package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/app"
	mcpdomain "github.com/xxww0098/podhub-go/internal/mcp/domain"
	mcprepo "github.com/xxww0098/podhub-go/internal/mcp/repo"
)

func TestMCPOriginUsesExactOriginBeforeExecution(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	t.Setenv("CLOUD_MCP_ALLOWED_HOSTS", "localhost")
	t.Setenv("CLOUD_MCP_ALLOWED_ORIGINS", "https://client.example")
	grant, token := seedMCPAuthorityGrant(t, ctx, pool)
	version, err := mcpdomain.Version(grant)
	if err != nil {
		t.Fatal(err)
	}
	handler := app.Handler(pool)
	for _, tc := range []struct {
		origin string
		want   int
	}{
		{"", 200},
		{"https://client.example", 200},
		{"https://client.example:443", 200},
		{"https://CLIENT.example", 200},
		{"https://client.example:8443", 403},
		{"http://client.example", 403},
		{"https://elsewhere.example", 403},
		{"https://client.example/path", 400},
		{"https://other@client.example", 400},
		{"https://client.example?query=value", 400},
		{"https://client.example#fragment", 400},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			execution := uuid.NewString()
			body, err := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": 1, "method": "tools/call",
				"params": map[string]any{"name": "execute", "arguments": map[string]any{
					"executionId": execution, "catalogVersion": version,
					"code": "return await sdk.workspace.getContext(input);", "input": map[string]any{},
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(string(body)))
			req.Host = "localhost"
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("origin gate = %d %s, want %d", rec.Code, rec.Body.String(), tc.want)
			}
			var rows int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM automation_executions WHERE grant_id=$1::uuid AND execution_id=$2::uuid`, grant.ID, execution).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			wantRows := 0
			if tc.want == http.StatusOK {
				wantRows = 1
				if !strings.Contains(rec.Body.String(), `"status":"completed"`) || !strings.Contains(rec.Body.String(), `"workspaceName":"Synthetic MCP authority"`) {
					t.Errorf("allowed execution did not complete: %s", rec.Body.String())
				}
			}
			if rows != wantRows {
				t.Errorf("origin produced %d persisted executions, want %d", rows, wantRows)
			}
		})
	}
}

func seedMCPAuthorityGrant(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (mcpdomain.Grant, string) {
	t.Helper()
	user, org := insertWorkspace(t, ctx, pool, uuid.NewString()+"@example.invalid", "Synthetic MCP authority")
	if _, err := pool.Exec(ctx, `INSERT INTO organization_members(org_id,user_id,role,status,display_name,join_order,created_at,updated_at)
 VALUES($1,$2,'owner','active','Synthetic MCP',1,clock_timestamp(),clock_timestamp()) ON CONFLICT (org_id,user_id) DO NOTHING`, org, user); err != nil {
		t.Fatal(err)
	}
	token := "opa_synthetic_" + uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO automation_grants(user_id,org_id,name,token_hash,token_prefix,actions)
 VALUES($1,$2,'Synthetic MCP',$3,'opa_synthetic',ARRAY['read']::text[])`, user, org, mcpdomain.HashToken(token)); err != nil {
		t.Fatal(err)
	}
	grant, err := mcprepo.New(pool).Resolve(ctx, mcpdomain.HashToken(token))
	if err != nil || grant == nil {
		t.Fatalf("resolve synthetic grant: %+v %v", grant, err)
	}
	return *grant, token
}
