package seal

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestCryptoVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/crypto-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Integration struct {
			KeyString string `json:"key_string"`
			Example   string `json:"example_rejected"`
			KeyHex    string `json:"key_hex"`
			NonceHex  string `json:"nonce_hex"`
			AAD       string `json:"aad_utf8"`
			Plain     string `json:"plaintext_utf8"`
			CipherHex string `json:"ciphertext_hex"`
			CipherLen int    `json:"ciphertext_len"`
			Legacy    struct {
				Plain     string `json:"plaintext_utf8"`
				CipherHex string `json:"ciphertext_hex"`
			} `json:"legacy_no_aad"`
		} `json:"integration_config"`
		V1 struct {
			KeyString   string `json:"key_string"`
			Example     string `json:"example_rejected"`
			KEKHex      string `json:"kek_hex"`
			AAD         string `json:"aad_utf8"`
			ClientID    string `json:"client_id"`
			APIKey      string `json:"api_key"`
			NonceHex    string `json:"nonce_hex"`
			CipherHex   string `json:"ciphertext_hex"`
			Fingerprint string `json:"fingerprint_hex"`
			Binding     struct {
				Org      int64 `json:"org_id"`
				Store    int64 `json:"store_id"`
				Revision int64 `json:"credential_revision"`
			} `json:"binding"`
		} `json:"store_credential_v1"`
		V2 struct {
			KEKHex       string `json:"kek_hex"`
			KeyID        string `json:"key_id"`
			PayloadNonce string `json:"payload_nonce_hex"`
			DEKNonce     string `json:"dek_nonce_hex"`
			PayloadAAD   string `json:"payload_aad_utf8"`
			WrapAAD      string `json:"wrap_aad_utf8"`
			Payload      string `json:"payload_ciphertext_hex"`
			Wrapped      string `json:"wrapped_dek_hex"`
		} `json:"store_credential_v2"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	kek, err := IntegrationKEK(doc.Integration.KeyString)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(kek) != doc.Integration.KeyHex {
		t.Fatalf("integration kek %x", kek)
	}
	if _, err := IntegrationKEK("short"); err == nil || err.Error() != "平台连接配置密钥未设置" {
		t.Fatalf("short key: %v", err)
	}
	if _, err := IntegrationKEK(doc.Integration.Example); err == nil || err.Error() != "平台连接配置密钥不能使用 .env.example 中的占位值" {
		t.Fatalf("example key: %v", err)
	}
	nonce := mustHex(t, doc.Integration.NonceHex)
	ct := mustHex(t, doc.Integration.CipherHex)
	if len(ct) != doc.Integration.CipherLen || doc.Integration.AAD != SnapshotAAD {
		t.Fatalf("ciphertext len %d aad %q", len(ct), doc.Integration.AAD)
	}
	plain, err := OpenIntegration(kek, nonce, ct)
	if err != nil || string(plain) != doc.Integration.Plain {
		t.Fatalf("open integration: %v %q", err, plain)
	}
	legacy, err := OpenIntegration(kek, nonce, mustHex(t, doc.Integration.Legacy.CipherHex))
	if err != nil || string(legacy) != doc.Integration.Legacy.Plain {
		t.Fatalf("legacy: %v %q", err, legacy)
	}
	if _, err := OpenIntegration(kek, []byte{1, 2}, ct); err == nil || err.Error() != "连接配置密文 nonce 长度无效" {
		t.Fatalf("nonce: %v", err)
	}
	if _, err := OpenIntegration(kek, nonce, []byte("nope")); err == nil || err.Error() != "连接配置快照解密失败" {
		t.Fatalf("decrypt: %v", err)
	}
	stored, err := ParseSnapshot(plain)
	if err != nil || stored.SchemaVersion != 1 || len(stored.Buckets) != 1 || stored.Buckets[0].Role != "private" || !stored.Buckets[0].Active {
		t.Fatalf("snapshot: %v %+v", err, stored.Buckets)
	}
	bad := []byte(doc.Integration.Plain)
	bad[len(`{"schemaVersion":`)] = '2'
	if _, err := ParseSnapshot(bad); err == nil || err.Error() != "已存储的连接配置 schema 版本不受支持" {
		t.Fatalf("schema: %v", err)
	}

	seller, err := SellerKEK(doc.V1.KeyString)
	if err != nil || hex.EncodeToString(seller) != doc.V1.KEKHex {
		t.Fatalf("seller kek %v %x", err, seller)
	}
	if _, err := SellerKEK(doc.V1.Example); err == nil {
		t.Fatal("example seller key opened")
	}
	if _, err := SellerKEK("too-short"); err == nil {
		t.Fatal("short seller key opened")
	}
	aad := StoreAAD(doc.V1.Binding.Org, doc.V1.Binding.Store, doc.V1.Binding.Revision)
	if aad != doc.V1.AAD {
		t.Fatalf("aad %s", aad)
	}
	clientID, apiKey, err := OpenPair(seller, aad, mustHex(t, doc.V1.NonceHex), mustHex(t, doc.V1.CipherHex))
	if err != nil || clientID != doc.V1.ClientID || apiKey != doc.V1.APIKey {
		t.Fatalf("v1 %v %s %s", err, clientID, apiKey)
	}
	if hex.EncodeToString(Fingerprint(seller, clientID, apiKey)) != doc.V1.Fingerprint {
		t.Fatalf("fingerprint %x", Fingerprint(seller, clientID, apiKey))
	}
	openedID, openedKey, err := OpenStored("k1", "k1", seller, nil, doc.V1.Binding.Org, doc.V1.Binding.Store, doc.V1.Binding.Revision, mustHex(t, doc.V1.NonceHex), mustHex(t, doc.V1.CipherHex), nil, nil)
	if err != nil || openedID != clientID || openedKey != apiKey {
		t.Fatalf("stored v1 %v", err)
	}

	if hex.EncodeToString(seller) != doc.V2.KEKHex {
		t.Fatal("v2 kek")
	}
	if WrapAAD(doc.V1.Binding.Org, doc.V1.Binding.Store, doc.V2.KeyID) != doc.V2.WrapAAD || aad != doc.V2.PayloadAAD {
		t.Fatalf("v2 aad")
	}
	clientID, apiKey, err = OpenV2(seller, doc.V2.PayloadAAD, doc.V2.WrapAAD, mustHex(t, doc.V2.PayloadNonce), mustHex(t, doc.V2.Payload), mustHex(t, doc.V2.DEKNonce), mustHex(t, doc.V2.Wrapped))
	if err != nil || clientID != doc.V1.ClientID || apiKey != doc.V1.APIKey {
		t.Fatalf("v2 %v %s %s", err, clientID, apiKey)
	}
	clientID, apiKey, err = OpenStored("k1", "k1", seller, nil, 7, 42, 3, mustHex(t, doc.V2.PayloadNonce), mustHex(t, doc.V2.Payload), mustHex(t, doc.V2.Wrapped), mustHex(t, doc.V2.DEKNonce))
	if err != nil || clientID != doc.V1.ClientID || apiKey != doc.V1.APIKey {
		t.Fatalf("stored v2 %v %s", err, clientID)
	}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
