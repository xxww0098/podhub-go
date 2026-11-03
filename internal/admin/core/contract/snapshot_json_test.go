package contract

import (
	"encoding/json"
	"strings"
	"testing"
)

const runtimeJSON = `"aiRuntime":{"maxConcurrencyGlobal":8,"maxConcurrencyUser":2,"maxConcurrencyAccount":4,"userRatePerMinute":30,"leaseTtlSeconds":120,"allowPublicEgress":true}`

func aiRow(id, model, purpose string) string {
	row := `{"id":"` + id + `","label":"L","baseUrl":"https://ai.example","apiFormat":"chat_completions","model":"` + model + `","apiKey":"k","active":true,"thinking":"provider_default","thinkingFormat":"none","priority":1`
	if purpose != "" {
		row += `,"purpose":"` + purpose + `"`
	}
	return row + `}`
}

func TestParseStoredMigratesPurposeByModelName(t *testing.T) {
	doc := `{"schemaVersion":1,"aiAccounts":[` + aiRow("a", "qwen3.7-flash", "") + `,` + aiRow("b", "qwen-image-2.1-pro", "") + `,` + aiRow("c", "qwen-image-2.1-pro", "ocr") + `],"aiDefaultModel":"qwen3.7-flash","storageBuckets":[]}`
	snap, legacy, err := ParseStored([]byte(doc))
	if err != nil || !legacy {
		t.Fatalf("legacy=%v err=%v", legacy, err)
	}
	got := []string{snap.AIAccounts[0].Purpose, snap.AIAccounts[1].Purpose, snap.AIAccounts[2].Purpose}
	if got[0] != PurposeOCR || got[1] != PurposeImage || got[2] != PurposeOCR {
		t.Fatalf("purposes %v: a stored purpose is never overwritten", got)
	}
	if snap.AIRuntime != DefaultAIRuntime() {
		t.Fatalf("absent aiRuntime must read as defaults, got %+v", snap.AIRuntime)
	}
	raw, err := snap.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	again, legacy, err := ParseStored(raw)
	if err != nil || legacy || again.AIAccounts[1].Purpose != PurposeImage {
		t.Fatalf("rewritten document: legacy=%v err=%v %+v", legacy, err, again.AIAccounts)
	}
}

func TestParseStoredMigratesPreviousAndSnakeDocuments(t *testing.T) {
	previous := `{"schemaVersion":1,"aiAccounts":[` + aiRow("a", "qwen-image-2.1-pro", "") + `],"aiDefaultModel":"","mediaAccounts":[]}`
	snap, legacy, err := ParseStored([]byte(previous))
	if err != nil || !legacy || snap.AIAccounts[0].Purpose != PurposeImage || snap.AIRuntime != DefaultAIRuntime() {
		t.Fatalf("previous: legacy=%v err=%v %+v", legacy, err, snap)
	}
	snake := `{"schema_version":1,"ai_default_model":"","ai_accounts":[{"id":"a","label":"L","base_url":"https://ai.example","api_format":"chat_completions","model":"m","api_key":"k","active":true,"thinking":"provider_default","thinking_format":"none","priority":1}],"media_accounts":[]}`
	snap, legacy, err = ParseStored([]byte(snake))
	if err != nil || !legacy || snap.AIAccounts[0].Purpose != PurposeOCR || snap.AIRuntime != DefaultAIRuntime() {
		t.Fatalf("snake: legacy=%v err=%v %+v", legacy, err, snap)
	}
}

func TestParseStoredCurrentDocumentKeepsRuntimeAndIsNotLegacy(t *testing.T) {
	doc := `{"schemaVersion":1,"aiDefaultModel":"m","aiAccounts":[` + aiRow("a", "m", "ocr") + `],` + runtimeJSON + `}`
	snap, legacy, err := ParseStored([]byte(doc))
	if err != nil || legacy {
		t.Fatalf("legacy=%v err=%v", legacy, err)
	}
	want := AIRuntime{MaxConcurrencyGlobal: 8, MaxConcurrencyUser: 2, MaxConcurrencyAccount: 4, UserRatePerMinute: 30, LeaseTTLSeconds: 120, AllowPublicEgress: true}
	if snap.AIRuntime != want {
		t.Fatalf("runtime %+v", snap.AIRuntime)
	}
	raw, err := snap.Marshal()
	if err != nil || !strings.Contains(string(raw), runtimeJSON) {
		t.Fatalf("marshal dropped the runtime: %s %v", raw, err)
	}
	if _, _, err := ParseStored([]byte(strings.Replace(doc, `"allowPublicEgress":true`, `"allowPublicEgress":true,"extra":1`, 1))); err == nil {
		t.Fatal("unknown aiRuntime field accepted")
	}
}

func TestParseStoredZeroLeaseReadsAsDefaultAndRewrites(t *testing.T) {
	doc := `{"schemaVersion":1,"aiDefaultModel":"","aiAccounts":[],"aiRuntime":{"maxConcurrencyGlobal":0,"maxConcurrencyUser":0,"maxConcurrencyAccount":0,"userRatePerMinute":0,"leaseTtlSeconds":0,"allowPublicEgress":false},"storageBuckets":[]}`
	snap, legacy, err := ParseStored([]byte(doc))
	if err != nil || !legacy || snap.AIRuntime.LeaseTTLSeconds != DefaultLeaseTTLSeconds {
		t.Fatalf("legacy=%v err=%v %+v", legacy, err, snap.AIRuntime)
	}
}

func TestParseStoredDiscardsRetiredStorage(t *testing.T) {
	base := Snapshot{
		SchemaVersion: 1, AIDefaultModel: "m", AIRuntime: DefaultAIRuntime(),
		AIAccounts: []StoredAI{{ID: "a", Model: "m", APIKey: "ai-key", Purpose: PurposeOCR}},
	}
	want, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, storage := range []string{"null", "[]", `[{"id":"private","secretAccessKey":"retired-secret"}]`} {
		t.Run(storage, func(t *testing.T) {
			raw := string(want[:len(want)-1]) + `,"storageBuckets":` + storage + `}`
			snapshot, rewrite, err := ParseStored([]byte(raw))
			if err != nil || !rewrite {
				t.Fatalf("retired storage must trigger cleanup: rewrite=%v err=%v", rewrite, err)
			}
			clean, err := json.Marshal(snapshot)
			if err != nil || string(clean) != string(want) {
				t.Fatalf("cleanup changed active configuration: %s %v", clean, err)
			}
			if _, rewrite, err := ParseStored(clean); err != nil || rewrite {
				t.Fatalf("clean snapshot requires another rewrite: %v %v", rewrite, err)
			}
		})
	}
}
