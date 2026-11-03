package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	usersrepo "github.com/xxww0098/podhub-go/internal/admin/users/repo"
)

func TestAdminUsersProductionRoleReads(t *testing.T) {
	f := newAdminContentFixture(t)
	status, raw := f.call(t, http.MethodGet, "/api/admin/users", "", f.admin)
	if status != http.StatusOK || !strings.Contains(string(raw), "a96311@example.invalid") || !strings.Contains(string(raw), "a96312@example.invalid") {
		t.Fatalf("directory: %d %s", status, raw)
	}
	var publicID string
	if err := f.fixture.QueryRow(f.ctx, `SELECT public_id FROM account_users WHERE id=96312`).Scan(&publicID); err != nil {
		t.Fatal(err)
	}
	users := usersrepo.NewUsers(f.runtime, nil)
	account, fault := users.ReadAccount(f.ctx, publicID)
	if fault != nil || account.ID != 96312 {
		t.Fatalf("read account: %+v, fault=%+v", account, fault)
	}
	status, raw = f.call(t, http.MethodPost, "/api/admin/users", `{"email":"admin-runtime-new@example.invalid","password":"runtime-new-password","name":"Runtime new","role":"user"}`, f.admin)
	var created struct {
		Data struct {
			User struct {
				UUID string `json:"uuid"`
			} `json:"user"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &created); err != nil || status != http.StatusCreated || created.Data.User.UUID == "" {
		t.Fatalf("create: %d %s, %v", status, raw, err)
	}
	for _, operation := range []struct{ path, body string }{
		{"status", `{"enabled":false}`},
		{"status", `{"enabled":true}`},
		{"admin", `{"role":"admin"}`},
		{"admin", `{"role":"user"}`},
		{"password", `{"password":"runtime-reset-password"}`},
	} {
		status, raw = f.call(t, http.MethodPost, "/api/admin/users/"+created.Data.User.UUID+"/"+operation.path, operation.body, f.admin)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %s", operation.path, status, raw)
		}
		f.assertClean(t)
	}
	status, raw = f.call(t, http.MethodGet, "/api/admin/users", "", f.admin)
	if status != http.StatusOK || !strings.Contains(string(raw), "admin-runtime-new@example.invalid") {
		t.Fatalf("created account readback: %d %s", status, raw)
	}
	f.assertClean(t)
}

func TestAdminObservationProductionRoleWire(t *testing.T) {
	f := newAdminContentFixture(t)
	for _, path := range []string{"/api/admin/ops/scopes", "/api/admin/ops/console/snapshot", "/api/admin/stores/products/overview", "/api/admin/stores/products?limit=1"} {
		t.Run(path, func(t *testing.T) {
			status, raw := f.call(t, http.MethodGet, path, "", f.admin)
			if status != http.StatusOK {
				t.Fatalf("read: %d %s", status, raw)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			assertObservationSnakeKeys(t, payload["data"])
			if strings.Contains(path, "console/snapshot") {
				var data struct {
					Generated int64 `json:"generated_at_ms"`
					Ledger    struct {
						Series []json.RawMessage `json:"series"`
					} `json:"ledger"`
				}
				if err := json.Unmarshal(payload["data"], &data); err != nil || data.Generated <= 0 || len(data.Ledger.Series) != 14 {
					t.Fatalf("console projection: %+v, %v", data, err)
				}
			}
			f.assertClean(t)
		})
	}
}

func assertObservationSnakeKeys(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	var inspect func(any)
	inspect = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			for key, child := range value {
				if strings.IndexFunc(key, func(r rune) bool { return r >= 'A' && r <= 'Z' }) >= 0 {
					t.Errorf("public observation property %q is not snake_case", key)
				}
				inspect(child)
			}
		case []any:
			for _, child := range value {
				inspect(child)
			}
		}
	}
	inspect(value)
}
