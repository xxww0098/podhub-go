package integration

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestIdentityEmailCaseUsesOneAccount(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"A96311@EXAMPLE.INVALID","password":"original-password"}`, "", "existing-case-login"))
	first := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/register", `{"email":"Case@Example.Invalid","password":"new-account-password","name":"Case account"}`, "", "email-case-register"))
	replayed := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/register", `{"email":"case@example.invalid","password":"new-account-password"}`, "", "email-case-register"))
	if first != replayed {
		t.Fatal("email case changed the registration replay session")
	}
	if response := f.request(http.MethodPost, "/api/auth/register", `{"email":"CASE@EXAMPLE.INVALID","password":"new-account-password"}`, "", ""); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "邮箱已注册") {
		t.Fatalf("case variant registration: %d %s", response.Code, response.Body.String())
	}
	identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"case@example.invalid","password":"new-account-password"}`, "", "email-case-login"))
	var accounts int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM account_users WHERE lower(email)='case@example.invalid'`).Scan(&accounts); err != nil || accounts != 1 {
		t.Fatalf("case variants created %d accounts: %v", accounts, err)
	}
	for i := 0; i < 7; i++ {
		email := "missing-case@example.invalid"
		if i%2 == 1 {
			email = strings.ToUpper(email)
		}
		response := f.request(http.MethodPost, "/api/auth/login", fmt.Sprintf(`{"email":%q,"password":"wrong-password"}`, email), "", "")
		want := http.StatusUnauthorized
		if i == 6 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("case variant throttle %d: %d %s", i, response.Code, response.Body.String())
		}
	}
	f.assertClean(t)
}
