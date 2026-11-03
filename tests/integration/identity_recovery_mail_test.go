package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"golang.org/x/crypto/bcrypt"
)

type recoveryMessage struct{ email, token string }

type recoveryMailer struct {
	mu       sync.Mutex
	messages []recoveryMessage
	send     func(context.Context, string, string) error
}

func (m *recoveryMailer) SendPasswordReset(ctx context.Context, email, token string) error {
	m.mu.Lock()
	m.messages = append(m.messages, recoveryMessage{email, token})
	send := m.send
	m.mu.Unlock()
	if send != nil {
		return send(ctx, email, token)
	}
	return nil
}

func (m *recoveryMailer) sent() []recoveryMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]recoveryMessage(nil), m.messages...)
}

func recoveryService(f identityRuntimeFixture, mailer *recoveryMailer) *identity.Service {
	return identity.New(f.runtime).WithPasswordRecovery(mailer, bytes.Repeat([]byte{23}, 32))
}

func recoveryConcurrentFixture(t *testing.T) identityRuntimeFixture {
	t.Helper()
	f := newIdentityRuntimeFixture(t)
	// Multiple database connections are required to exercise row-lock order;
	// the regular identity fixture deliberately has only one connection.
	cfg := f.runtime.Config()
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	f.runtime = pool
	return f
}

func recoveryForgot(ctx context.Context, svc *identity.Service, email, ip string) identity.Result {
	body, _ := json.Marshal(map[string]string{"email": email})
	r := httptest.NewRequest(http.MethodPost, "/api/auth/forgot", bytes.NewReader(body)).WithContext(ctx)
	r.RemoteAddr = ip + ":43210"
	return svc.Forgot(r)
}

func recoveryReset(ctx context.Context, svc *identity.Service, token, password string) identity.Result {
	body, _ := json.Marshal(map[string]string{"token": token, "password": password})
	return svc.Reset(httptest.NewRequest(http.MethodPost, "/api/auth/reset", bytes.NewReader(body)).WithContext(ctx))
}

func requireRecoveryAccepted(t *testing.T, result identity.Result) {
	t.Helper()
	if result.Status != http.StatusOK || !strings.Contains(string(result.Body), `"ok":true`) {
		t.Fatalf("recovery request: %d %s", result.Status, result.Body)
	}
}

func requireRecoveryDrain(t *testing.T, f identityRuntimeFixture, svc *identity.Service) {
	t.Helper()
	if n, err := svc.DeliverPasswordResets(f.ctx, 4); err != nil || n != 1 {
		t.Fatalf("mail drain: processed=%d err=%v", n, err)
	}
}

func requireRecoveryState(t *testing.T, f identityRuntimeFixture, token, want string, wiped bool) {
	t.Helper()
	var state string
	var payloadGone bool
	if err := f.fixture.QueryRow(f.ctx, `SELECT state,secret_nonce IS NULL AND secret_ciphertext IS NULL FROM auth_password_reset_deliveries WHERE token_hash=$1`, sha256Hex(token)).Scan(&state, &payloadGone); err != nil || state != want || payloadGone != wiped {
		t.Fatalf("delivery state=%q wiped=%v want=%q/%v err=%v", state, payloadGone, want, wiped, err)
	}
}

func TestIdentityRecoveryMailAcceptedAndDelivered(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	mailer := &recoveryMailer{}
	svc := recoveryService(f, mailer)
	unknown := recoveryForgot(f.ctx, svc, "missing@example.invalid", "198.51.100.1")
	requireRecoveryAccepted(t, unknown)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=96312`); err != nil {
		t.Fatal(err)
	}
	disabled := recoveryForgot(f.ctx, svc, "a96312@example.invalid", "198.51.100.2")
	requireRecoveryAccepted(t, disabled)
	first := recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.3")
	requireRecoveryAccepted(t, first)
	cooldown := recoveryForgot(f.ctx, svc, "A96311@EXAMPLE.INVALID", "198.51.100.4")
	requireRecoveryAccepted(t, cooldown)
	for _, result := range []identity.Result{disabled, first, cooldown} {
		if !bytes.Equal(result.Body, unknown.Body) {
			t.Fatalf("account existence changed response: %s / %s", result.Body, unknown.Body)
		}
	}
	var tokens, deliveries int
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM auth_email_tokens),(SELECT count(*) FROM auth_password_reset_deliveries)`).Scan(&tokens, &deliveries); err != nil || tokens != 1 || deliveries != 1 || len(mailer.sent()) != 0 {
		t.Fatalf("request must enqueue once without SMTP: tokens=%d deliveries=%d sent=%d err=%v", tokens, deliveries, len(mailer.sent()), err)
	}
	oldSessions := []string{
		identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "mail-session-1")),
		identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "mail-session-2")),
	}
	mailer.send = func(ctx context.Context, _, _ string) error {
		if got := f.runtime.Stat().AcquiredConns(); got != 0 {
			return fmt.Errorf("SMTP retained %d database connections", got)
		}
		probeCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		var n int
		return f.runtime.QueryRow(probeCtx, "SELECT 1").Scan(&n)
	}
	requireRecoveryDrain(t, f, svc)
	messages := mailer.sent()
	if len(messages) != 1 || messages[0].email != "a96311@example.invalid" || !identity.IsSessionToken(messages[0].token) {
		t.Fatalf("delivered unexpected recovery envelope: count=%d", len(messages))
	}
	token := messages[0].token
	requireRecoveryState(t, f, token, "sent", true)
	result := recoveryReset(f.ctx, svc, token, "recovered-password")
	if result.Status != http.StatusOK {
		t.Fatalf("delivered link reset: %d %s", result.Status, result.Body)
	}
	for _, session := range oldSessions {
		f.requireAnonymous(t, session)
	}
	if result := recoveryReset(f.ctx, svc, token, "replayed-password"); result.Status != http.StatusBadRequest {
		t.Fatalf("reset replay: %d %s", result.Status, result.Body)
	}
	identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"recovered-password"}`, "", "mail-new-password"))
	f.assertClean(t)
}

func TestIdentityRecoveryMailRetriesAndTerminalFailures(t *testing.T) {
	for _, test := range []struct {
		name    string
		failure error
		want    string
	}{
		{"temporary retry", errors.New("temporary SMTP outage"), "pending"},
		{"delivery timeout", context.DeadlineExceeded, "pending"},
		{"permanent rejection", identity.ErrResetMailRejected, "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newIdentityRuntimeFixture(t)
			mailer := &recoveryMailer{send: func(context.Context, string, string) error { return test.failure }}
			svc := recoveryService(f, mailer)
			requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.5"))
			requireRecoveryDrain(t, f, svc)
			token := mailer.sent()[0].token
			requireRecoveryState(t, f, token, test.want, test.want == "failed")
			if test.want == "failed" {
				if r := recoveryReset(f.ctx, svc, token, "rejected-password"); r.Status != http.StatusBadRequest {
					t.Fatalf("permanently rejected link usable: %d %s", r.Status, r.Body)
				}
				if n, err := svc.DeliverPasswordResets(f.ctx, 4); err != nil || n != 0 {
					t.Fatalf("terminal delivery retried: %d %v", n, err)
				}
			} else {
				var ciphertext []byte
				if err := f.fixture.QueryRow(f.ctx, `SELECT secret_ciphertext FROM auth_password_reset_deliveries WHERE token_hash=$1`, sha256Hex(token)).Scan(&ciphertext); err != nil || bytes.Contains(ciphertext, []byte(token)) {
					t.Fatalf("retry token stored in plaintext or missing: %v", err)
				}
				mailer.send = nil
				if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_password_reset_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, sha256Hex(token)); err != nil {
					t.Fatal(err)
				}
				// A new Service proves the retry does not depend on process memory.
				requireRecoveryDrain(t, f, recoveryService(f, mailer))
				if sent := mailer.sent(); len(sent) != 2 || sent[0] != sent[1] {
					t.Fatal("retry changed recovery recipient or token")
				}
				requireRecoveryState(t, f, token, "sent", true)
			}
			f.assertClean(t)
		})
	}
}

func TestIdentityRecoveryMailExhaustionPreservesDeliveredLink(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	mailer := &recoveryMailer{}
	svc := recoveryService(f, mailer)
	requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.9"))
	requireRecoveryDrain(t, f, svc)
	first := mailer.sent()[0].token
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_email_tokens SET created_at=clock_timestamp()-interval '61 seconds'`); err != nil {
		t.Fatal(err)
	}
	requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.9"))
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_password_reset_deliveries SET attempts=4 WHERE state='pending'`); err != nil {
		t.Fatal(err)
	}
	mailer.send = func(context.Context, string, string) error {
		return errors.New("temporary SMTP outage with private server details")
	}
	requireRecoveryDrain(t, f, svc)
	second := mailer.sent()[1].token
	requireRecoveryState(t, f, second, "failed", true)
	requireRecoveryState(t, f, first, "sent", true)
	var attempts int
	var code string
	if err := f.fixture.QueryRow(f.ctx, `SELECT attempts,last_error_code FROM auth_password_reset_deliveries WHERE token_hash=$1`, sha256Hex(second)).Scan(&attempts, &code); err != nil || attempts != 5 || code != "exhausted" {
		t.Fatalf("exhaustion state: attempts=%d code=%q err=%v", attempts, code, err)
	}
	if r := recoveryReset(f.ctx, svc, second, "failed-mail-password"); r.Status != http.StatusBadRequest {
		t.Fatalf("exhausted link usable: %d %s", r.Status, r.Body)
	}
	if r := recoveryReset(f.ctx, svc, first, "delivered-link-password"); r.Status != http.StatusOK {
		t.Fatalf("later mail failure revoked delivered link: %d %s", r.Status, r.Body)
	}
	f.assertClean(t)
}

func TestIdentityRecoveryMailLeaseAndInvalidPayload(t *testing.T) {
	for _, kind := range []string{"expired token", "damaged ciphertext", "expired lease", "exhausted lease"} {
		t.Run(kind, func(t *testing.T) {
			f := newIdentityRuntimeFixture(t)
			mailer := &recoveryMailer{}
			svc := recoveryService(f, mailer)
			requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.6"))
			var hash string
			if err := f.fixture.QueryRow(f.ctx, `SELECT token_hash FROM auth_password_reset_deliveries`).Scan(&hash); err != nil {
				t.Fatal(err)
			}
			var sql string
			switch kind {
			case "expired token":
				sql = `UPDATE auth_email_tokens SET expires_at=clock_timestamp()-interval '1 second'`
			case "damaged ciphertext":
				sql = `UPDATE auth_password_reset_deliveries SET secret_ciphertext=decode(repeat('ff',64),'hex')`
			case "expired lease":
				sql = `UPDATE auth_password_reset_deliveries SET state='sending',attempts=1,lease_token='crashed-process',lease_until=clock_timestamp()-interval '1 second'`
			case "exhausted lease":
				sql = `UPDATE auth_password_reset_deliveries SET state='sending',attempts=5,lease_token='crashed-process',lease_until=clock_timestamp()-interval '1 second'`
			}
			if _, err := f.fixture.Exec(f.ctx, sql); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.DeliverPasswordResets(f.ctx, 4); err != nil {
				t.Fatal(err)
			}
			var state string
			var wiped bool
			if err := f.fixture.QueryRow(f.ctx, `SELECT state,secret_nonce IS NULL AND secret_ciphertext IS NULL FROM auth_password_reset_deliveries WHERE token_hash=$1`, hash).Scan(&state, &wiped); err != nil {
				t.Fatal(err)
			}
			if kind == "expired lease" {
				if state != "sent" || len(mailer.sent()) != 1 || !wiped {
					t.Fatalf("lease recovery state=%s sent=%d wiped=%v", state, len(mailer.sent()), wiped)
				}
			} else if state != "failed" || len(mailer.sent()) != 0 || !wiped {
				t.Fatalf("invalid job state=%s sent=%d wiped=%v", state, len(mailer.sent()), wiped)
			}
			f.assertClean(t)
		})
	}
}

func TestIdentityRecoveryMailStaleClaimCannotFinish(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	mailer := &recoveryMailer{send: func(ctx context.Context, _, _ string) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	svc := recoveryService(f, mailer)
	requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.7"))
	done := make(chan error, 1)
	go func() { _, err := svc.DeliverPasswordResets(f.ctx, 1); done <- err }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("SMTP did not start")
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_password_reset_deliveries SET lease_token='replacement-claim'`); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var state, claim string
	var wiped bool
	if err := f.fixture.QueryRow(f.ctx, `SELECT state,lease_token,secret_ciphertext IS NULL FROM auth_password_reset_deliveries`).Scan(&state, &claim, &wiped); err != nil || state != "sending" || claim != "replacement-claim" || wiped {
		t.Fatalf("stale claim overwrote new claim: %q %q wiped=%v err=%v", state, claim, wiped, err)
	}
	f.assertClean(t)
}

func TestIdentityRecoveryMailThrottleAndConcurrentRequests(t *testing.T) {
	f := recoveryConcurrentFixture(t)
	mailer := &recoveryMailer{}
	svc := recoveryService(f, mailer)
	for i := 0; i < 6; i++ {
		r := recoveryForgot(f.ctx, svc, fmt.Sprintf("missing%d@example.invalid", i), "198.51.100.8")
		if i < 5 {
			requireRecoveryAccepted(t, r)
		} else if r.Status != http.StatusTooManyRequests || r.RetryAfter == "" {
			t.Fatalf("IP throttle status=%d retry=%q body=%s", r.Status, r.RetryAfter, r.Body)
		}
	}
	spoof := httptest.NewRequest(http.MethodPost, "/api/auth/forgot", strings.NewReader(`{"email":"missing@example.invalid"}`)).WithContext(f.ctx)
	spoof.RemoteAddr = "198.51.100.8:43210"
	spoof.Header.Set("X-Forwarded-For", "203.0.113.99")
	if result := svc.Forgot(spoof); result.Status != http.StatusTooManyRequests {
		t.Fatalf("direct client bypassed IP throttle with forwarded header: %d %s", result.Status, result.Body)
	}
	results := make(chan identity.Result, 8)
	for i := 0; i < 8; i++ {
		go func(i int) {
			results <- recoveryForgot(f.ctx, svc, "a96311@example.invalid", fmt.Sprintf("198.51.100.%d", 20+i))
		}(i)
	}
	for i := 0; i < 8; i++ {
		requireRecoveryAccepted(t, <-results)
	}
	var n int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM auth_password_reset_deliveries`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("concurrent requests created %d deliveries: %v", n, err)
	}
	requireRecoveryDrain(t, f, svc)
	if len(mailer.sent()) != 1 {
		t.Fatalf("concurrent requests sent %d emails", len(mailer.sent()))
	}
	f.assertClean(t)
}

func TestIdentityRecoveryRequestRacesReset(t *testing.T) {
	f := recoveryConcurrentFixture(t)
	svc := recoveryService(f, &recoveryMailer{})
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{41}, 32))
	f.emailToken(t, token, "reset")
	// The legacy link must not activate the request cooldown for this race.
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_email_tokens SET created_at=clock_timestamp()-interval '61 seconds'`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan identity.Result, 2)
	go func() { <-start; results <- recoveryReset(ctx, svc, token, "race-reset-password") }()
	go func() { <-start; results <- recoveryForgot(ctx, svc, "a96311@example.invalid", "198.51.100.10") }()
	close(start)
	for i := 0; i < 2; i++ {
		result := <-results
		if result.Status != http.StatusOK {
			t.Fatalf("request/reset race failed or deadlocked: %d %s", result.Status, result.Body)
		}
	}
	if result := recoveryReset(f.ctx, svc, token, "replayed-race-password"); result.Status != http.StatusBadRequest {
		t.Fatalf("raced token replay: %d %s", result.Status, result.Body)
	}
	f.assertClean(t)
}

func TestIdentityRecoveryConcurrentResetAndAuditRollback(t *testing.T) {
	f := recoveryConcurrentFixture(t)
	svc := recoveryService(f, &recoveryMailer{})
	tokens := []string{base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{31}, 32)), base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{32}, 32))}
	for _, token := range tokens {
		f.emailToken(t, token, "reset")
	}
	results := make(chan identity.Result, 2)
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	for _, token := range tokens {
		go func(token string) { results <- recoveryReset(ctx, svc, token, "concurrent-password") }(token)
	}
	success, invalid := 0, 0
	for range tokens {
		r := <-results
		switch r.Status {
		case http.StatusOK:
			success++
		case http.StatusBadRequest:
			invalid++
		default:
			t.Fatalf("concurrent reset: %d %s", r.Status, r.Body)
		}
	}
	if success != 1 || invalid != 1 {
		t.Fatalf("concurrent links accepted success=%d invalid=%d", success, invalid)
	}

	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{33}, 32))
	f.emailToken(t, token, "reset")
	session := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"concurrent-password"}`, "", "before-mail-audit"))
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE audit_logs ADD CONSTRAINT recovery_mail_reject_audit CHECK(action<>'password_reset') NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if r := recoveryReset(f.ctx, svc, token, "rollback-password"); r.Status != http.StatusInternalServerError {
		t.Fatalf("audit refusal: %d %s", r.Status, r.Body)
	}
	var hash string
	var consumed bool
	var sessions int
	if err := f.fixture.QueryRow(f.ctx, `SELECT password_hash,(SELECT consumed_at IS NOT NULL FROM auth_email_tokens WHERE token_hash=$1),(SELECT count(*) FROM account_sessions WHERE user_id=96311) FROM account_users WHERE id=96311`, sha256Hex(token)).Scan(&hash, &consumed, &sessions); err != nil || consumed || sessions != 1 || bcrypt.CompareHashAndPassword([]byte(hash), []byte("concurrent-password")) != nil {
		t.Fatalf("failed audit did not roll back password/token/sessions: consumed=%v sessions=%d err=%v", consumed, sessions, err)
	}
	if r := f.request(http.MethodGet, "/api/auth/session", "", session, ""); !strings.Contains(r.Body.String(), `"authenticated":true`) {
		t.Fatalf("audit failure revoked session: %d %s", r.Code, r.Body.String())
	}
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE audit_logs DROP CONSTRAINT recovery_mail_reject_audit`); err != nil {
		t.Fatal(err)
	}
	f.assertClean(t)
}

func TestIdentityRecoveryCleanupDoesNotDeadlockCredentialChange(t *testing.T) {
	f := recoveryConcurrentFixture(t)
	mailer := &recoveryMailer{}
	svc := recoveryService(f, mailer)
	requireRecoveryAccepted(t, recoveryForgot(f.ctx, svc, "a96311@example.invalid", "198.51.100.11"))
	if _, err := f.fixture.Exec(f.ctx, `UPDATE auth_email_tokens SET expires_at=clock_timestamp()-interval '8 days';
		CREATE FUNCTION recovery_cleanup_pause() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.state='failed' THEN PERFORM pg_advisory_xact_lock(96311,10); END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER recovery_cleanup_pause BEFORE UPDATE ON auth_password_reset_deliveries
		FOR EACH ROW EXECUTE FUNCTION recovery_cleanup_pause()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.fixture.Exec(context.Background(), `DROP TRIGGER IF EXISTS recovery_cleanup_pause ON auth_password_reset_deliveries; DROP FUNCTION IF EXISTS recovery_cleanup_pause()`)
	})
	ctx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
	defer cancel()
	gate, err := f.fixture.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), time.Second)
		defer cleanupCancel()
		_, _ = gate.Exec(cleanupCtx, `SELECT pg_advisory_unlock(96311,10)`)
	}()
	var gatePID int
	if err := gate.QueryRow(ctx, `SELECT pg_backend_pid() FROM pg_advisory_lock(96311,10)`).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	ready := make(chan int, 1)
	changeCredentials := make(chan struct{})
	credentialDone := make(chan error, 1)
	go func() {
		credentialDone <- db.InTx(ctx, f.runtime, db.AppRole(), func(tx pgx.Tx) error {
			var pid int
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM account_users WHERE id=96311 FOR UPDATE`).Scan(&pid); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `SELECT token_hash FROM auth_email_tokens WHERE user_id=96311 FOR UPDATE`); err != nil {
				return err
			}
			ready <- pid
			select {
			case <-changeCredentials:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err := tx.Exec(ctx, `UPDATE account_users SET email='recovery-cleanup-changed@example.invalid' WHERE id=96311`)
			return err
		})
	}()
	var credentialPID int
	select {
	case credentialPID = <-ready:
	case err := <-credentialDone:
		t.Fatalf("credential lock setup: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	drainDone := make(chan error, 1)
	go func() {
		n, err := svc.DeliverPasswordResets(ctx, 4)
		if err == nil && n != 0 {
			err = fmt.Errorf("expired delivery processed %d emails", n)
		}
		drainDone <- err
	}()
	// The advisory gate holds expire after its delivery row lock. Observe both
	// database waits before releasing it, so this catches the former lock cycle.
	drainPID := waitRecoveryBlockedPID(t, ctx, gate, `SELECT pid FROM pg_stat_activity WHERE usename='podhub_login_api' AND wait_event='advisory' AND $1::int=ANY(pg_blocking_pids(pid))`, gatePID)
	close(changeCredentials)
	waitRecoveryBlockedPID(t, ctx, gate, `SELECT $1::int WHERE $2::int=ANY(pg_blocking_pids($1::int))`, credentialPID, drainPID)
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_unlock(96311,10)`); err != nil {
		t.Fatal(err)
	}
	for name, done := range map[string]<-chan error{"drain": drainDone, "credential update": credentialDone} {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("%s failed or deadlocked: %v", name, err)
			}
		case <-ctx.Done():
			t.Fatalf("%s did not finish: %v", name, ctx.Err())
		}
	}
	var tokens, deliveries int
	if err := gate.QueryRow(ctx, `SELECT (SELECT count(*) FROM auth_email_tokens),(SELECT count(*) FROM auth_password_reset_deliveries)`).Scan(&tokens, &deliveries); err != nil || tokens != 1 || deliveries != 1 {
		t.Fatalf("locked owner was not skipped: tokens=%d deliveries=%d err=%v", tokens, deliveries, err)
	}
	if n, err := svc.DeliverPasswordResets(ctx, 4); err != nil || n != 0 {
		t.Fatalf("unlocked cleanup: processed=%d err=%v", n, err)
	}
	if err := gate.QueryRow(ctx, `SELECT (SELECT count(*) FROM auth_email_tokens),(SELECT count(*) FROM auth_password_reset_deliveries)`).Scan(&tokens, &deliveries); err != nil || tokens != 0 || deliveries != 0 || len(mailer.sent()) != 0 {
		t.Fatalf("expired recovery retention: tokens=%d deliveries=%d sent=%d err=%v", tokens, deliveries, len(mailer.sent()), err)
	}
	f.assertClean(t)
}

func waitRecoveryBlockedPID(t *testing.T, ctx context.Context, conn *pgxpool.Conn, query string, args ...any) int {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int
		err := conn.QueryRow(ctx, query, args...).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("observe recovery lock wait: %v", err)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatalf("expected database lock wait did not occur: %v", ctx.Err())
		}
	}
}
