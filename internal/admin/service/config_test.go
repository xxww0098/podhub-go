package service

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestConfigReplacementDropsStorageAndPreservesPayment(t *testing.T) {
	payment := &seal.StoredPaymentConfig{}
	old, _, err := domain.ParseStored([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[{"id":"private","secretAccessKey":"storage-secret"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	old.Payment = payment
	snapshot, view, fault := normalizeConfig(&old, ConfigIn{Expected: 8}, false)
	if fault != nil {
		t.Fatal(fault)
	}
	if snapshot.Payment != payment || view.Revision != 9 {
		t.Fatal("replacement must drop storage settings and preserve payment")
	}
	stored, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("storage-secret")) || bytes.Contains(stored, []byte("storageBuckets")) {
		t.Fatal("replacement retained storage credentials")
	}
	response, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(response, []byte("storage")) {
		t.Fatal("configuration response still exposes storage settings")
	}
}

func aiIn(id, model, purpose string, active bool, priority int64) AIIn {
	return AIIn{ID: id, Label: id, BaseURL: "https://ai.example/v1", APIFormat: "chat_completions", Model: model, APIKey: "k", Active: active, Priority: priority, Purpose: purpose}
}

func TestConfigRequiresValidPurpose(t *testing.T) {
	for _, purpose := range []string{"", "OCR", "text", " "} {
		_, _, fault := normalizeConfig(nil, ConfigIn{AI: []AIIn{aiIn("a", "m", purpose, true, 1)}}, false)
		if fault == nil || fault.Status != 400 || !strings.Contains(fault.Message, "用途") {
			t.Fatalf("purpose %q: %+v", purpose, fault)
		}
	}
	snap, view, fault := normalizeConfig(nil, ConfigIn{AI: []AIIn{aiIn("a", "m", "ocr", true, 1), aiIn("b", "qwen-image-2.1-pro", " image ", true, 1), aiIn("c", "chat-model", "chat", true, 1)}}, false)
	if fault != nil || snap.AIAccounts[0].Purpose != "ocr" || snap.AIAccounts[1].Purpose != "image" || snap.AIAccounts[2].Purpose != "chat" {
		t.Fatalf("%+v %+v", snap.AIAccounts, fault)
	}
	if view.AI[0].Purpose != "ocr" || view.AI[1].Purpose != "image" || view.AI[2].Purpose != "chat" {
		t.Fatalf("view %+v", view.AI)
	}
	textOnly := aiIn("d", "m", "chat", true, 1)
	textOnly.APIFormat = "anthropic_messages"
	if _, _, fault := normalizeConfig(nil, ConfigIn{AI: []AIIn{textOnly}}, false); fault != nil {
		t.Fatalf("chat anthropic account: %+v", fault)
	}
	ocrAnthropic := aiIn("e", "m", "ocr", true, 1)
	ocrAnthropic.APIFormat = "anthropic_messages"
	if _, _, fault := normalizeConfig(nil, ConfigIn{AI: []AIIn{ocrAnthropic}}, false); fault == nil {
		t.Fatal("ocr account accepted a non-chat format")
	}
}

func TestDefaultModelNeverComesFromAnImageAccount(t *testing.T) {
	ais := []AIIn{aiIn("img", "image-model", "image", true, 99), aiIn("ocr", "ocr-model", "ocr", true, 1)}
	snap, _, fault := normalizeConfig(nil, ConfigIn{AI: ais}, false)
	if fault != nil || snap.AIDefaultModel != "ocr-model" {
		t.Fatalf("derived default %q %+v", snap.AIDefaultModel, fault)
	}
	requested := "image-model"
	_, _, fault = normalizeConfig(nil, ConfigIn{AI: ais, AIDefault: &requested}, false)
	if fault == nil || fault.Status != 400 || !strings.Contains(fault.Message, "识图") {
		t.Fatalf("image account accepted as default: %+v", fault)
	}
	onlyImage := []AIIn{aiIn("img", "image-model", "image", true, 1)}
	snap, _, fault = normalizeConfig(nil, ConfigIn{AI: onlyImage}, false)
	if fault != nil || snap.AIDefaultModel != "" {
		t.Fatalf("image-only pool derived default %q %+v", snap.AIDefaultModel, fault)
	}
}

func TestRuntimeValidationAndRetention(t *testing.T) {
	valid := domain.AIRuntime{MaxConcurrencyGlobal: 10, MaxConcurrencyUser: 2, MaxConcurrencyAccount: 5, UserRatePerMinute: 60, LeaseTTLSeconds: 120, AllowPublicEgress: true}
	snap, view, fault := normalizeConfig(nil, ConfigIn{Runtime: &valid}, false)
	if fault != nil || snap.AIRuntime != valid || view.Runtime != runtimeView(valid) {
		t.Fatalf("%+v %+v %+v", snap.AIRuntime, view.Runtime, fault)
	}
	raw, err := json.Marshal(view)
	if err != nil || !strings.Contains(string(raw), `"ai_runtime":{"max_concurrency_global":10,"max_concurrency_user":2,"max_concurrency_account":5,"user_rate_per_minute":60,"lease_ttl_seconds":120,"allow_public_egress":true}`) {
		t.Fatalf("wire %s %v", raw, err)
	}

	// Omitted retains the stored settings; nothing stored yields the defaults.
	retained, _, fault := normalizeConfig(&domain.Snapshot{AIRuntime: valid}, ConfigIn{}, false)
	if fault != nil || retained.AIRuntime != valid {
		t.Fatalf("omitted runtime not retained: %+v %+v", retained.AIRuntime, fault)
	}
	fresh, _, fault := normalizeConfig(nil, ConfigIn{}, false)
	if fault != nil || fresh.AIRuntime != domain.DefaultAIRuntime() {
		t.Fatalf("fresh defaults: %+v %+v", fresh.AIRuntime, fault)
	}

	off := valid
	off.MaxConcurrencyGlobal, off.UserRatePerMinute = 0, 0
	if _, _, fault := normalizeConfig(nil, ConfigIn{Runtime: &off}, false); fault != nil {
		t.Fatalf("zero ceilings turn a limit off: %+v", fault)
	}
	for name, edit := range map[string]func(*domain.AIRuntime){
		"global negative":  func(r *domain.AIRuntime) { r.MaxConcurrencyGlobal = -1 },
		"user too large":   func(r *domain.AIRuntime) { r.MaxConcurrencyUser = 100001 },
		"account negative": func(r *domain.AIRuntime) { r.MaxConcurrencyAccount = -5 },
		"rate too large":   func(r *domain.AIRuntime) { r.UserRatePerMinute = 100001 },
		"lease zero":       func(r *domain.AIRuntime) { r.LeaseTTLSeconds = 0 },
		"lease too large":  func(r *domain.AIRuntime) { r.LeaseTTLSeconds = 3601 },
	} {
		bad := valid
		edit(&bad)
		if _, _, fault := normalizeConfig(nil, ConfigIn{Runtime: &bad}, false); fault == nil || fault.Status != 400 {
			t.Fatalf("%s accepted: %+v", name, fault)
		}
	}
	top := valid
	top.MaxConcurrencyGlobal, top.LeaseTTLSeconds = 100000, 3600
	if _, _, fault := normalizeConfig(nil, ConfigIn{Runtime: &top}, false); fault != nil {
		t.Fatalf("upper bounds rejected: %+v", fault)
	}
}

func TestGetConfigDefaultsRuntimeWithoutRow(t *testing.T) {
	api := &API{DB: &rewriteDB{}, IntegrationKey: rewriteKey}
	out, fault := api.GetConfig(context.Background())
	if fault != nil {
		t.Fatal(fault)
	}
	raw, _ := json.Marshal(out)
	if !strings.Contains(string(raw), `"lease_ttl_seconds":90`) || !strings.Contains(string(raw), `"allow_public_egress":false`) {
		t.Fatalf("%s", raw)
	}
}
