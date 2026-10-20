package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRedactWipesSensitiveVectors(t *testing.T) {
	vectors := []string{
		"Bearer abc",
		"BEARER abc.def",
		"sk-abcdefghijklmnopqrst",
		"4111111111111111",
		"4111-1111-1111-1111",
		"4111 1111 1111 1111",
		"api_key=secret",
		"Api-Key: live-secret",
		"user@example.com",
		"13800138000",
		`{"offer_id":"SKU-9","price":"12.50","recipient":"Ada","address":"Main Street","phone":"13800138000","email":"user@example.com"}`,
	}
	markers := []string{
		"Bearer", "bearer", "sk-", "4111111111111111", "4111-1111-1111-1111",
		"4111 1111 1111 1111", "api_key", "Api-Key", "live-secret",
		"user@example.com", "13800138000", "SKU-9", "12.50", "Ada", "Main Street",
	}
	for _, vector := range vectors {
		got := Redact(vector)
		if got == vector {
			t.Fatalf("unchanged %q", vector)
		}
		for _, marker := range markers {
			if strings.Contains(vector, marker) && strings.Contains(got, marker) {
				t.Fatalf("redact left %q in %q from %q", marker, got, vector)
			}
		}
	}
}

func TestProjectDropsPayloadSecrets(t *testing.T) {
	payload := `{
		"code":"Bearer abc",
		"apiPath":"/api/orders/4111111111111111?api_key=secret",
		"apiStatus":"500",
		"message":"sk-abcdefghijklmnopqrst user@example.com",
		"email":"user@example.com",
		"phone":"13800138000",
		"fingerprint":"sk-abcdefghijklmnopqrst",
		"stack":"token=secret",
		"recipient":"Ada",
		"address":"Main Street",
		"offer_id":"SKU-9"
	}`
	piece := Project(Observation{
		OrgID: 7, Kind: "error_feedback.v1", Payload: payload,
		At: time.Date(2026, 10, 17, 6, 30, 0, 0, time.UTC),
	})
	if piece.Drop {
		t.Fatal("projection dropped a redactable error")
	}
	raw, err := json.Marshal(piece)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, marker := range []string{
		"Bearer", "sk-", "4111111111111111", "api_key", "secret",
		"user@example.com", "13800138000", "Ada", "Main Street", "SKU-9",
		"token=",
	} {
		if strings.Contains(text, marker) {
			t.Fatalf("stored %s in %s", marker, text)
		}
	}
	if piece.StatusCode != 500 || piece.RouteTemplate != "/api/orders/{id}" {
		t.Fatalf("status %d route %s", piece.StatusCode, piece.RouteTemplate)
	}
	if piece.Summary == "" || len(piece.Fingerprint) != 64 {
		t.Fatalf("summary %q fp %s", piece.Summary, piece.Fingerprint)
	}
	again := Project(Observation{OrgID: 7, Kind: "error_feedback.v1", Payload: payload, At: piece.At})
	if again.Fingerprint != piece.Fingerprint {
		t.Fatal("fingerprint drifted")
	}
}

func TestAggregateSeparatesTenantAndPlatform(t *testing.T) {
	start := time.Date(2026, 10, 17, 6, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	obs := []Observation{
		{OrgID: 1, Kind: "desktop_error_log.v1", Payload: `{"code":"E_SAME","apiPath":"/api/listing/intents/{id}"}`, At: start.Add(time.Minute)},
		{OrgID: 1, Kind: "desktop_error_log.v1", Payload: `{"code":"E_SAME","apiPath":"/api/listing/intents/{id}","message":"api_key=secret"}`, At: start.Add(2 * time.Minute)},
		{OrgID: 2, Kind: "desktop_error_log.v1", Payload: `{"code":"E_SAME","apiPath":"/api/listing/intents/{id}","email":"a@b.co"}`, At: start.Add(3 * time.Minute)},
		{OrgID: 1, Kind: "billing.ai-token-usage.v1", Payload: `{"code":"usage"}`, At: start.Add(time.Minute)},
		{OrgID: 1, Kind: "desktop_error_log.v1", Payload: `{"code":"E_SAME"}`, At: end},
		{OrgID: 0, Kind: "desktop_error_log.v1", Payload: `{"code":"E_SAME"}`, At: start.Add(time.Minute)},
	}
	rows, dropped := Aggregate(obs, start, end)
	if dropped != 1 {
		t.Fatalf("dropped %d", dropped)
	}
	var tenant, platform int
	var platformCount int64
	for _, row := range rows {
		blob, _ := json.Marshal(row)
		if strings.Contains(string(blob), "api_key") || strings.Contains(string(blob), "a@b.co") || strings.Contains(string(blob), "secret") {
			t.Fatalf("row leaked %s", blob)
		}
		if row.Platform {
			platform++
			platformCount = row.Count
			if row.OrgID != 0 {
				t.Fatalf("platform org %d", row.OrgID)
			}
		} else {
			tenant++
			if row.OrgID != 1 && row.OrgID != 2 {
				t.Fatalf("tenant org %d", row.OrgID)
			}
			if row.OrgID == 1 && row.Count != 2 {
				t.Fatalf("org 1 count %d", row.Count)
			}
		}
	}
	if tenant != 2 || platform != 1 || platformCount != 3 {
		t.Fatalf("tenant %d platform %d count %d rows %+v", tenant, platform, platformCount, rows)
	}
}
