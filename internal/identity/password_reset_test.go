package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestResetRejectsMalformedTokensBeforePasswordWork(t *testing.T) {
	s := &Service{pool: &pgxpool.Pool{}, slots: make(chan struct{}, 1)}
	for _, value := range []string{"", " ", strings.Repeat("A", 42), strings.Repeat("A", 44), " " + strings.Repeat("A", 42), "+" + strings.Repeat("A", 42), strings.Repeat("A", 42) + "="} {
		t.Run(value, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"token": value, "password": "reset-password"})
			if err != nil {
				t.Fatal(err)
			}
			result := s.Reset(httptest.NewRequest(http.MethodPost, "/api/auth/reset", strings.NewReader(string(body))))
			if result.Status != http.StatusBadRequest || !strings.Contains(string(result.Body), msgBadLink) {
				t.Fatalf("malformed token: status=%d body=%s", result.Status, result.Body)
			}
		})
	}
}

func TestResetSharesPasswordSlots(t *testing.T) {
	s := &Service{pool: &pgxpool.Pool{}, slots: make(chan struct{}, 1)}
	body := `{"token":"` + strings.Repeat("A", 43) + `","password":"reset-password"}`
	result := s.Reset(httptest.NewRequest(http.MethodPost, "/api/auth/reset", strings.NewReader(body)))
	if result.Status != http.StatusTooManyRequests || !strings.Contains(string(result.Body), `"code":"RATE_LIMITED"`) {
		t.Fatalf("exhausted password slots: status=%d body=%s", result.Status, result.Body)
	}
}

func TestResetReturnsPasswordSlotAfterFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pool, err := pgxpool.New(ctx, "postgres://127.0.0.1:1/reset-test?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s := &Service{pool: pool, slots: make(chan struct{}, 1)}
	s.releasePassword()
	for _, body := range []string{
		`{`,
		`{"token":"` + strings.Repeat("A", 43) + `","password":"short"}`,
		`{"token":"` + strings.Repeat("A", 43) + `","password":"reset-password"}`,
	} {
		result := s.Reset(httptest.NewRequest(http.MethodPost, "/api/auth/reset", strings.NewReader(body)).WithContext(ctx))
		if result.Status < http.StatusBadRequest || len(s.slots) != 1 {
			t.Fatalf("failure leaked password slot: status=%d slots=%d body=%s", result.Status, len(s.slots), result.Body)
		}
	}
}
