package integration

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestIdentityResetPreservesAccountState(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	session := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "reset-state"))
	expired := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	valid := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	f.emailToken(t, expired, "reset")
	f.emailToken(t, valid, "reset")
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_email_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, sha256Hex(expired)); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", " " + valid, valid + "=", strings.Repeat("A", 43), expired} {
		body := fmt.Sprintf(`{"token":%q,"password":"reset-password"}`, value)
		if response := f.request(http.MethodPost, "/api/auth/reset", body, "", ""); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid reset token %q: %d %s", value, response.Code, response.Body.String())
		}
	}
	body := fmt.Sprintf(`{"token":%q,"password":"reset-password"}`, valid)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp(),must_change_password=true WHERE id=96311`); err != nil {
		t.Fatal(err)
	}
	if response := f.request(http.MethodPost, "/api/auth/reset", body, "", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("disabled account reset: %d %s", response.Code, response.Body.String())
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=96311; ALTER TABLE audit_logs ADD CONSTRAINT identity_reset_reject_audit CHECK(action<>'password_reset')`); err != nil {
		t.Fatal(err)
	}
	// Disabling an account revokes its existing recovery links. A fresh link is
	// needed after reactivation to exercise the independent audit rollback.
	if response := f.request(http.MethodPost, "/api/auth/reset", body, "", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("reactivation restored revoked reset link: %d %s", response.Code, response.Body.String())
	}
	valid = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	f.emailToken(t, valid, "reset")
	body = fmt.Sprintf(`{"token":%q,"password":"reset-password"}`, valid)
	if response := f.request(http.MethodPost, "/api/auth/reset", body, "", ""); response.Code != http.StatusInternalServerError {
		t.Fatalf("failed reset audit: %d %s", response.Code, response.Body.String())
	}
	var hash string
	var consumed bool
	var sessions int
	if err := f.fixture.QueryRow(f.ctx, `SELECT password_hash,(SELECT consumed_at IS NOT NULL FROM auth_email_tokens WHERE token_hash=$1),(SELECT count(*) FROM account_sessions WHERE user_id=96311) FROM account_users WHERE id=96311`, sha256Hex(valid)).Scan(&hash, &consumed, &sessions); err != nil || consumed || sessions != 1 || bcrypt.CompareHashAndPassword([]byte(hash), []byte("original-password")) != nil {
		t.Fatalf("rejected reset changed account state: consumed=%v sessions=%d err=%v", consumed, sessions, err)
	}
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE audit_logs DROP CONSTRAINT identity_reset_reject_audit`); err != nil {
		t.Fatal(err)
	}
	if response := f.request(http.MethodPost, "/api/auth/reset", body, "", ""); response.Code != http.StatusOK {
		t.Fatalf("valid reset: %d %s", response.Code, response.Body.String())
	}
	f.requireAnonymous(t, session)
	var locked bool
	var audits int
	if err := f.fixture.QueryRow(f.ctx, `SELECT password_hash,must_change_password,(SELECT count(*) FROM audit_logs WHERE user_id=96311 AND action='password_reset'),(SELECT consumed_at IS NOT NULL FROM auth_email_tokens WHERE token_hash=$1) FROM account_users WHERE id=96311`, sha256Hex(valid)).Scan(&hash, &locked, &audits, &consumed); err != nil || !locked || !consumed || audits != 1 || bcrypt.CompareHashAndPassword([]byte(hash), []byte("reset-password")) != nil {
		t.Fatalf("reset state: locked=%v consumed=%v audits=%d err=%v", locked, consumed, audits, err)
	}
	if response := f.request(http.MethodPost, "/api/auth/reset", body, "", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("consumed token replay: %d %s", response.Code, response.Body.String())
	}
	identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"reset-password"}`, "", "reset-new-password"))
	f.assertClean(t)
}
