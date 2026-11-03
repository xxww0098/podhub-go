package domain

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestSnapshotReadersShareCamelDocument(t *testing.T) {
	raw := readVectors(t)
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for name := range doc {
		seen[name] = true
		switch name {
		case "integration_config":
			assertIntegrationVector(t, doc[name])
		case "store_credential_v1":
			assertCredentialV1(t, doc[name])
		case "store_credential_v2":
			assertCredentialV2(t, doc[name], doc["store_credential_v1"])
		default:
			t.Fatalf("crypto-vectors.json has an unhandled vector %q", name)
		}
	}
	for _, name := range []string{"integration_config", "store_credential_v1", "store_credential_v2"} {
		if !seen[name] {
			t.Fatalf("missing vector %s", name)
		}
	}
}

func assertIntegrationVector(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var vector struct {
		KeyString string `json:"key_string"`
		NonceHex  string `json:"nonce_hex"`
		Plain     string `json:"plaintext_utf8"`
		CipherHex string `json:"ciphertext_hex"`
		Legacy    struct {
			Plain     string `json:"plaintext_utf8"`
			CipherHex string `json:"ciphertext_hex"`
		} `json:"legacy_no_aad"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	// The vector predates aiRuntime and environment-only storage.
	snap, legacy, err := ParseStored([]byte(vector.Plain))
	if err != nil || !legacy {
		t.Fatalf("parse vector: legacy=%v err=%v", legacy, err)
	}
	if snap.AIRuntime != DefaultAIRuntime() {
		t.Fatalf("vector runtime %+v", snap.AIRuntime)
	}
	again, err := json.Marshal(snap)
	want := `{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","aiRuntime":{"maxConcurrencyGlobal":0,"maxConcurrencyUser":0,"maxConcurrencyAccount":0,"userRatePerMinute":0,"leaseTtlSeconds":90,"allowPublicEgress":false}}`
	if err != nil || string(again) != want {
		t.Fatalf("writer bytes\n got %s\nwant %s\nerr %v", again, want, err)
	}
	if _, err := seal.ParseSnapshot(again); err != nil {
		t.Fatal(err)
	}
	if _, legacy, err := ParseStored(again); err != nil || legacy {
		t.Fatalf("migrated vector reread legacy=%v err=%v", legacy, err)
	}
	key := KeySHA256(vector.KeyString)
	nonce, err := hex.DecodeString(vector.NonceHex)
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := hex.DecodeString(vector.CipherHex)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := Open(key, []byte(seal.SnapshotAAD), nonce, cipher)
	if err != nil || string(plain) != vector.Plain {
		t.Fatalf("open vector: %v %s", err, plain)
	}
	legacyPlain, err := Open(key, nil, nonce, mustHex(t, vector.Legacy.CipherHex))
	if err != nil || string(legacyPlain) != vector.Legacy.Plain {
		t.Fatalf("legacy aad: %v %s", err, legacyPlain)
	}
}

func TestAdminWriteRoundTripAndSnakeRewrite(t *testing.T) {
	payment := &seal.StoredPaymentConfig{Providers: []seal.StoredPaymentProvider{{
		Provider: "manual", Enabled: false, Values: map[string]string{"appId": "kept"},
	}}}
	snap := Snapshot{
		SchemaVersion: 1,
		AIAccounts: []StoredAI{{
			ID: "ai", Label: "主账号", BaseURL: "https://ai.example", APIFormat: "chat_completions",
			Model: "m", APIKey: "k", Active: true, Thinking: "provider_default", ThinkingFormat: "none", Priority: 3, Purpose: PurposeOCR,
		}},
		AIDefaultModel: "m",
		AIRuntime:      AIRuntime{MaxConcurrencyGlobal: 8, MaxConcurrencyUser: 2, MaxConcurrencyAccount: 4, UserRatePerMinute: 30, LeaseTTLSeconds: 120, AllowPublicEgress: true},
		Payment:        payment,
	}
	camel, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seal.ParseSnapshot(camel); err != nil {
		t.Fatal(err)
	}
	parsed, legacy, err := ParseStored(camel)
	if err != nil || legacy || parsed.AIAccounts[0].APIKey != "k" || parsed.AIAccounts[0].Purpose != PurposeOCR || parsed.AIRuntime != snap.AIRuntime || mustPayment(t, parsed.Payment) != mustPayment(t, payment) {
		t.Fatalf("camel reread legacy=%v err=%v %+v", legacy, err, parsed)
	}

	// Rewriting old documents preserves AI and payment and removes storage.
	snake := []byte(`{"schema_version":1,"ai_default_model":"m","ai_accounts":[{"id":"ai","label":"主账号","base_url":"https://ai.example","api_format":"chat_completions","model":"m","api_key":"k","active":true,"thinking":"provider_default","thinking_format":"none","priority":3}],"media_accounts":[{"id":"media","label":"切片","provider":"cloudflare","endpoint":"https://acct.r2.cloudflarestorage.com","region":"auto","bucket":"podhub-slices","key_prefix":"slices","public_base_url":"https://cdn.example","force_path_style":true,"access_key_id":"AKIA","secret_access_key":"secret","session_token":"","active":true}],"supplier_db_storage":{"id":"supplier","label":"切片","provider":"cloudflare","endpoint":"https://acct.r2.cloudflarestorage.com","region":"auto","bucket":"supplier-db","key_prefix":"slices","public_base_url":"https://supplier.example","force_path_style":true,"access_key_id":"AKIA","secret_access_key":"secret","session_token":"","active":true},"delegate_assets_storage":{"id":"delegate","label":"delegate-assets","provider":"cloudflare","endpoint":"https://acct.r2.cloudflarestorage.com","region":"auto","bucket":"delegate-assets","key_prefix":"","public_base_url":"","force_path_style":true,"access_key_id":"AKIA","secret_access_key":"secret","session_token":"","active":true},"payment":{"providers":[{"provider":"manual","enabled":false,"values":{"appId":"kept"}}]}}`)
	if _, err := seal.ParseSnapshot(snake); err == nil {
		t.Fatal("delegate reader accepted snake_case")
	}
	old, legacy, err := ParseStored(snake)
	if err != nil || !legacy {
		t.Fatalf("snake read legacy=%v err=%v", legacy, err)
	}
	rewritten, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rewritten), "AKIA") || strings.Contains(string(rewritten), "storageBuckets") {
		t.Fatal("rewritten snapshot retained storage settings")
	}
	again, legacy, err := ParseStored(rewritten)
	if err != nil || legacy || again.AIAccounts[0].APIKey != "k" || mustPayment(t, again.Payment) != mustPayment(t, payment) {
		t.Fatalf("rewritten reread legacy=%v err=%v", legacy, err)
	}
	if _, _, err := ParseStored([]byte(`{"schemaVersion":2,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[]}`)); err == nil || err.Error() != errSnapshotVersion.Error() {
		t.Fatalf("camel version: %v", err)
	}
	if _, _, err := ParseStored([]byte(`{"schema_version":2,"ai_accounts":[],"ai_default_model":"","media_accounts":[]}`)); err == nil || err.Error() != errSnapshotVersion.Error() {
		t.Fatalf("snake version: %v", err)
	}
	if _, _, err := ParseStored([]byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[],"extra":1}`)); err == nil {
		t.Fatal("unknown camel field accepted")
	}
}

func mustPayment(t *testing.T, payment *seal.StoredPaymentConfig) string {
	t.Helper()
	raw, err := json.Marshal(payment)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func assertCredentialV1(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var vector struct {
		KeyString string `json:"key_string"`
		Example   string `json:"example_rejected"`
		KEKHex    string `json:"kek_hex"`
		AAD       string `json:"aad_utf8"`
		ClientID  string `json:"client_id"`
		APIKey    string `json:"api_key"`
		NonceHex  string `json:"nonce_hex"`
		CipherHex string `json:"ciphertext_hex"`
		Print     string `json:"fingerprint_hex"`
		Binding   struct {
			Org      int64 `json:"org_id"`
			Store    int64 `json:"store_id"`
			Revision int64 `json:"credential_revision"`
		} `json:"binding"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	kek, err := seal.SellerKEK(vector.KeyString)
	if err != nil || hex.EncodeToString(kek) != vector.KEKHex {
		t.Fatalf("v1 kek %v", err)
	}
	if _, err := seal.SellerKEK(vector.Example); err == nil {
		t.Fatal("example seller key opened")
	}
	clientID, apiKey, err := seal.OpenStored("k1", "k1", kek, nil, vector.Binding.Org, vector.Binding.Store, vector.Binding.Revision, mustHex(t, vector.NonceHex), mustHex(t, vector.CipherHex), nil, nil)
	if err != nil || clientID != vector.ClientID || apiKey != vector.APIKey {
		t.Fatalf("v1 %v %s %s", err, clientID, apiKey)
	}
	if hex.EncodeToString(seal.Fingerprint(kek, clientID, apiKey)) != vector.Print {
		t.Fatal("fingerprint")
	}
	if seal.StoreAAD(vector.Binding.Org, vector.Binding.Store, vector.Binding.Revision) != vector.AAD {
		t.Fatal("aad")
	}
}

func assertCredentialV2(t *testing.T, raw, v1raw json.RawMessage) {
	t.Helper()
	var v1 struct {
		ClientID string `json:"client_id"`
		APIKey   string `json:"api_key"`
		Binding  struct {
			Org      int64 `json:"org_id"`
			Store    int64 `json:"store_id"`
			Revision int64 `json:"credential_revision"`
		} `json:"binding"`
	}
	var vector struct {
		KEKHex       string `json:"kek_hex"`
		KeyID        string `json:"key_id"`
		PayloadNonce string `json:"payload_nonce_hex"`
		DEKNonce     string `json:"dek_nonce_hex"`
		PayloadAAD   string `json:"payload_aad_utf8"`
		WrapAAD      string `json:"wrap_aad_utf8"`
		Payload      string `json:"payload_ciphertext_hex"`
		Wrapped      string `json:"wrapped_dek_hex"`
	}
	if err := json.Unmarshal(v1raw, &v1); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	kek, err := hex.DecodeString(vector.KEKHex)
	if err != nil {
		t.Fatal(err)
	}
	clientID, apiKey, err := seal.OpenV2(kek, vector.PayloadAAD, vector.WrapAAD, mustHex(t, vector.PayloadNonce), mustHex(t, vector.Payload), mustHex(t, vector.DEKNonce), mustHex(t, vector.Wrapped))
	if err != nil || clientID != v1.ClientID || apiKey != v1.APIKey {
		t.Fatalf("v2 %v %s", err, clientID)
	}
	if seal.WrapAAD(v1.Binding.Org, v1.Binding.Store, vector.KeyID) != vector.WrapAAD || seal.StoreAAD(v1.Binding.Org, v1.Binding.Store, v1.Binding.Revision) != vector.PayloadAAD {
		t.Fatal("v2 aad")
	}
}

func readVectors(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../platform/seal/testdata/crypto-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
