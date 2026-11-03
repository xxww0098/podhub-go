package slicestorage_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

func securityDSN(t *testing.T, ctx context.Context) string {
	t.Helper()
	container, err := postgres.Run(ctx, "postgres:16-alpine", postgres.WithDatabase("podhub"), postgres.WithUsername("postgres"), postgres.WithPassword("postgres"), postgres.BasicWaitStrategies(), testcontainers.WithCmdArgs("-c", "max_locks_per_transaction=256"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = container.Terminate(context.Background()) })
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	return dsn
}
func swapUser(dsn, user, password string) string {
	u, _ := url.Parse(dsn)
	u.User = url.UserPassword(user, password)
	return u.String()
}
func postJSON(t *testing.T, handler http.Handler, path, body, idempotency, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}
func sessionCookie(rec *httptest.ResponseRecorder) string {
	for _, cookie := range rec.Header().Values("Set-Cookie") {
		if strings.HasPrefix(cookie, "sid=") {
			return cookie
		}
	}
	return rec.Header().Get("Set-Cookie")
}
func seedMatchingLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool, domain, reason string) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO writer_leases(domain,holder,holder_instance,fence_token,granted_at_ms,expires_at_ms,heartbeat_at_ms,grant_reason)
		VALUES($1,'axum',$2,1,0,(extract(epoch FROM clock_timestamp())*1000)::bigint+600000,(extract(epoch FROM clock_timestamp())*1000)::bigint,$3)`, domain, fmt.Sprintf("axum-%d", os.Getpid()), reason)
	if err != nil {
		t.Fatal(err)
	}
}
func transitResponse[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	if rec.Code != 200 {
		t.Fatalf("response %d: %s", rec.Code, rec.Body.String())
	}
	var data T
	if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	return data
}
