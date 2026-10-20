package seal

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	// ExampleIntegrationKey is the .env.example placeholder. It must not open snapshots.
	ExampleIntegrationKey = "set-a-random-32-plus-character-server-secret"
	// ExampleSellerKey is the published seller credential sample.
	ExampleSellerKey = "change-me-seller-credential-key-32chars"
	// SnapshotAAD is platform_integration_config|v1.
	SnapshotAAD = "platform_integration_config|v1"
	// DefaultSellerKeyID is current_key_id when CLOUD_SELLER_CREDENTIAL_KEY_ID is blank.
	DefaultSellerKeyID = "k1"

	fingerprintInfo = "seller-credential-fingerprint"
)

// KeyError is a 503 from derive_encryption_key or derive_key.
type KeyError struct{ Message string }

func (e *KeyError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// IntegrationKEK is SHA-256 of the trimmed CLOUD_INTEGRATION_CONFIG_KEY.
func IntegrationKEK(raw string) ([]byte, error) {
	value := strings.TrimSpace(raw)
	if len(value) < 32 {
		return nil, &KeyError{Message: "平台连接配置密钥未设置"}
	}
	if value == ExampleIntegrationKey {
		return nil, &KeyError{Message: "平台连接配置密钥不能使用 .env.example 中的占位值"}
	}
	sum := sha256.Sum256([]byte(value))
	return sum[:], nil
}

// SellerKEK is SHA-256 of the trimmed CLOUD_SELLER_CREDENTIAL_KEY.
func SellerKEK(raw string) ([]byte, error) {
	value := strings.TrimSpace(raw)
	if len(value) < 32 || value == ExampleSellerKey {
		return nil, &KeyError{Message: "seller credential key unavailable"}
	}
	sum := sha256.Sum256([]byte(value))
	return sum[:], nil
}

// OpenIntegration tries the snapshot AAD, then the legacy ciphertext with no AAD.
func OpenIntegration(key, nonce, ciphertext []byte) ([]byte, error) {
	if len(nonce) != 12 {
		return nil, errors.New("连接配置密文 nonce 长度无效")
	}
	if plain, err := open(key, nonce, ciphertext, []byte(SnapshotAAD)); err == nil {
		return plain, nil
	}
	plain, err := open(key, nonce, ciphertext, nil)
	if err != nil {
		return nil, errors.New("连接配置快照解密失败")
	}
	return plain, nil
}

// StoreAAD is store_seller_credential|v1|{org}|{store}|{revision}.
func StoreAAD(orgID, storeID, revision int64) string {
	return fmt.Sprintf("store_seller_credential|v1|%d|%d|%d", orgID, storeID, revision)
}

// WrapAAD is store_seller_dek|v2|{org}|{store}|{key_id}.
func WrapAAD(orgID, storeID int64, keyID string) string {
	return fmt.Sprintf("store_seller_dek|v2|%d|%d|%s", orgID, storeID, keyID)
}

// OpenPair decrypts client_id NUL api_key.
func OpenPair(key []byte, aad string, nonce, ciphertext []byte) (string, string, error) {
	plain, err := open(key, nonce, ciphertext, []byte(aad))
	if err != nil {
		return "", "", ErrEnvelope
	}
	return splitPair(plain)
}

// OpenV2 unwraps the DEK, then opens the payload under the store AAD.
func OpenV2(kek []byte, storeAAD, wrapAAD string, nonce, ciphertext, dekNonce, wrapped []byte) (string, string, error) {
	if len(wrapped) != 48 || len(dekNonce) != 12 {
		return "", "", ErrEnvelope
	}
	dek, err := open(kek, dekNonce, wrapped, []byte(wrapAAD))
	if err != nil || len(dek) != 32 {
		return "", "", ErrEnvelope
	}
	return OpenPair(dek, storeAAD, nonce, ciphertext)
}

// OpenStored opens a v1 or v2 row. A row stamped with the current key id
// uses only the current KEK. Any other stamp tries current, then previous.
func OpenStored(currentID, rowID string, current, previous []byte, orgID, storeID, revision int64, nonce, ciphertext, wrapped, dekNonce []byte) (string, string, error) {
	if len(current) != 32 {
		return "", "", ErrEnvelope
	}
	keys := [][]byte{current}
	if rowID != currentID && previous != nil {
		if len(previous) != 32 {
			return "", "", ErrEnvelope
		}
		keys = append(keys, previous)
	}
	storeAAD := StoreAAD(orgID, storeID, revision)
	v2 := len(wrapped) > 0 && len(dekNonce) > 0
	var last error = ErrEnvelope
	for _, key := range keys {
		var clientID, apiKey string
		var err error
		if v2 {
			clientID, apiKey, err = OpenV2(key, storeAAD, WrapAAD(orgID, storeID, rowID), nonce, ciphertext, dekNonce, wrapped)
		} else {
			clientID, apiKey, err = OpenPair(key, storeAAD, nonce, ciphertext)
		}
		if err == nil {
			return clientID, apiKey, nil
		}
		last = err
	}
	return "", "", last
}

// Fingerprint is HMAC-SHA256(HMAC-SHA256(KEK, info), plaintext).
func Fingerprint(kek []byte, clientID, apiKey string) []byte {
	pepperMAC := hmac.New(sha256.New, kek)
	_, _ = pepperMAC.Write([]byte(fingerprintInfo))
	pepper := pepperMAC.Sum(nil)
	mac := hmac.New(sha256.New, pepper)
	_, _ = mac.Write([]byte(clientID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(apiKey))
	return mac.Sum(nil)
}

// SnapshotBucket is one camelCase storage account inside the integration
// snapshot. Role is transit, assets or private.
type SnapshotBucket struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	Role            string `json:"role"`
	Provider        string `json:"provider"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	KeyPrefix       string `json:"keyPrefix"`
	PublicBaseURL   string `json:"publicBaseUrl"`
	ForcePathStyle  bool   `json:"forcePathStyle"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	SessionToken    string `json:"sessionToken"`
	Active          bool   `json:"active"`
}

// Snapshot is StoredConfig. Unknown fields are rejected.
// Payment is optional. The crypto vector omits it. A present payment object
// uses StoredPaymentConfig (providers required, unknown keys rejected).
type Snapshot struct {
	SchemaVersion  int                  `json:"schemaVersion"`
	AIAccounts     json.RawMessage      `json:"aiAccounts"`
	AIDefaultModel string               `json:"aiDefaultModel"`
	Buckets        []SnapshotBucket     `json:"storageBuckets"`
	Payment        *StoredPaymentConfig `json:"payment,omitempty"`
}

// ParseSnapshot decodes a decrypted integration snapshot.
func ParseSnapshot(plain []byte) (Snapshot, error) {
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	var stored Snapshot
	if err := dec.Decode(&stored); err != nil {
		return Snapshot{}, errors.New("已加密的连接配置快照无法解析")
	}
	if stored.SchemaVersion != 1 {
		return Snapshot{}, errors.New("已存储的连接配置 schema 版本不受支持")
	}
	return stored, nil
}

func splitPair(plain []byte) (string, string, error) {
	i := bytes.IndexByte(plain, 0)
	if i < 0 {
		return "", "", ErrEnvelope
	}
	clientID := plain[:i]
	apiKey := plain[i+1:]
	if !utf8.Valid(clientID) || !utf8.Valid(apiKey) {
		return "", "", ErrEnvelope
	}
	return string(clientID), string(apiKey), nil
}
