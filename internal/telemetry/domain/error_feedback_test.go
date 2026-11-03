package domain

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestErrorFeedbackContract(t *testing.T) {
	fixture, err := os.ReadFile("../../../fixtures/telemetry/error-feedback.json")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(fixture, &payload); err != nil {
		t.Fatal(err)
	}
	id := payload["errorId"].(string)
	got := mustAccept(t, id, "error_feedback.v1", string(fixture), 1)
	var stored map[string]any
	if err := json.Unmarshal([]byte(got.Payload), &stored); err != nil || !reflect.DeepEqual(stored, payload) {
		t.Fatalf("receipt changed: %s, %v", got.Payload, err)
	}

	for _, key := range []string{"status", "apiStatus"} {
		t.Run(key, func(t *testing.T) {
			original := payload[key]
			defer func() { payload[key] = original }()
			for _, value := range []int{100, 599} {
				payload[key] = value
				body, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				mustAccept(t, id, "error_feedback.v1", string(body), 1)
			}
			for _, value := range []any{99, 600, 503.5, "503", nil, true, []int{503}, map[string]int{"status": 503}} {
				payload[key] = value
				body, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				text := string(body)
				if _, rejected := AcceptInboxItem(WireItem{ID: id, Kind: "error_feedback.v1", PayloadJSON: &text}); rejected == nil {
					t.Fatalf("accepted invalid %s=%v", key, value)
				}
			}
		})
	}

	for _, badID := range []string{"12345678901234567890", strings.ToLower(id), "7K3M-9Q2D-6R8PT", id[:12], id + "0", "G000000000000", "7K3I9Q2D6R8PT", "7K3L9Q2D6R8PT", "7K3O9Q2D6R8PT", "7K3U9Q2D6R8PT"} {
		t.Run(badID, func(t *testing.T) {
			payload["errorId"] = badID
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			text := string(body)
			if _, rejected := AcceptInboxItem(WireItem{ID: badID, Kind: "error_feedback.v1", PayloadJSON: &text}); rejected == nil {
				t.Fatalf("accepted invalid errorId=%s", badID)
			}
		})
	}
	payload["errorId"] = id
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if _, rejected := AcceptInboxItem(WireItem{ID: "0000000000001", Kind: "error_feedback.v1", PayloadJSON: &text}); rejected == nil {
		t.Fatal("accepted mismatched envelope and receipt IDs")
	}
}
