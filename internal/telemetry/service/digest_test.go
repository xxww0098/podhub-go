package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

type memDigest struct {
	obs  []domain.Observation
	rows []domain.DigestRow
}

func (m *memDigest) ErrorWindow(context.Context, time.Time, time.Time) ([]domain.Observation, error) {
	return m.obs, nil
}

func (m *memDigest) SaveDigest(_ context.Context, rows []domain.DigestRow) error {
	m.rows = rows
	return nil
}

func TestAggregateHourWritesRedactedWindowOnly(t *testing.T) {
	start := time.Date(2026, 10, 17, 6, 0, 0, 0, time.UTC)
	store := &memDigest{obs: []domain.Observation{
		{
			OrgID: 4, Kind: "desktop_error_log.v1",
			Payload: `{"code":"E1","message":"Bearer abc","api_key":"secret","email":"user@example.com","phone":"13800138000","card":"4111111111111111"}`,
			At:      start.Add(10 * time.Minute),
		},
		{
			OrgID: 4, Kind: "billing.ai-token-usage.v1",
			Payload: `{"code":"usage","message":"sk-abcdefghijklmnopqrst"}`,
			At:      start.Add(11 * time.Minute),
		},
	}}
	dropped, err := AggregateHour(context.Background(), store, start.Add(time.Hour+5*time.Minute))
	if err != nil || dropped != 0 {
		t.Fatalf("dropped %d %v", dropped, err)
	}
	if len(store.rows) != 2 {
		t.Fatalf("rows %d", len(store.rows))
	}
	for _, row := range store.rows {
		text := row.Summary + row.RouteTemplate + row.Fingerprint
		for _, marker := range []string{"Bearer", "sk-", "4111111111111111", "api_key", "user@example.com", "13800138000", "secret"} {
			if strings.Contains(text, marker) {
				t.Fatalf("kept %s in %s", marker, text)
			}
		}
		if row.WindowStart != start {
			t.Fatalf("window %s", row.WindowStart)
		}
	}
}
