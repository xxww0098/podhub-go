// Package seal opens store credential envelopes.
//
// The byte layout below is local. The Rust envelope source was not in this
// workspace (仓库无法对照), so these functions are not a golden of
// src/store_seller_credentials.rs. Tests round-trip this layout only.
//
// There is no media_accounts table in the head schema. Store rows live in
// store_seller_credentials. OpenBlob is the same AES-256-GCM opener for a
// nonce-plus-ciphertext pair such as platform_integration_config.
package seal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

const dekAADPrefix = "dek\x00"

// ErrEnvelope means the ciphertext, nonce, or fingerprint did not open.
var ErrEnvelope = errors.New("credential envelope did not open")

// Ring holds the current seller KEK and the previous one.
// Key material is already derived. An empty slice is skipped.
type Ring struct {
	Primary  []byte
	Previous []byte
}

// DeriveKEK turns a config string into 32 bytes.
// A trimmed hex or standard-base64 string of 32 bytes is used as-is.
// A raw 32-byte string is used as-is. Anything else is SHA-256 of the
// original, untrimmed value. This is not a second parser of the write switches.
func DeriveKEK(raw string) []byte {
	trimmed := strings.TrimSpace(raw)
	if b, err := hex.DecodeString(trimmed); err == nil && len(b) == 32 {
		return b
	}
	if b, err := base64.StdEncoding.DecodeString(trimmed); err == nil && len(b) == 32 {
		return b
	}
	if len(raw) == 32 {
		return []byte(raw)
	}
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

// Store is one store_seller_credentials envelope.
// Version 1 keeps ClientID in the clear and seals the API key.
// Version 2 seals clientID NUL apiKey under a wrapped DEK.
type Store struct {
	Version     int
	ClientID    string
	KeyID       string
	Nonce       []byte
	Ciphertext  []byte
	WrappedDEK  []byte
	DEKNonce    []byte
	Fingerprint []byte
}

// Secret is the opened client id and API key.
type Secret struct {
	ClientID string
	APIKey   string
}

// OpenStore tries the primary KEK, then the previous one.
func (r Ring) OpenStore(env Store) (Secret, error) {
	var last error
	for _, kek := range [][]byte{r.Primary, r.Previous} {
		if len(kek) != 32 {
			continue
		}
		secret, err := openStore(kek, env)
		if err == nil {
			return secret, nil
		}
		last = err
	}
	if last == nil {
		last = ErrEnvelope
	}
	return Secret{}, last
}

// SealV1 seals apiKey with AAD equal to keyID. ClientID stays outside.
func SealV1(kek []byte, keyID, clientID, apiKey string) (Store, error) {
	nonce, ct, err := seal(kek, []byte(apiKey), []byte(keyID))
	if err != nil {
		return Store{}, err
	}
	sum := sha256.Sum256([]byte(apiKey))
	return Store{
		Version: 1, ClientID: clientID, KeyID: keyID,
		Nonce: nonce, Ciphertext: ct, Fingerprint: sum[:],
	}, nil
}

// SealV2 wraps a fresh DEK. AAD for the DEK is "dek\x00"+keyID.
// The payload is clientID NUL apiKey with AAD keyID. The wrapped DEK is 48 bytes.
func SealV2(kek []byte, keyID, clientID, apiKey string) (Store, error) {
	dek := make([]byte, 32)
	if _, err := rand.Read(dek); err != nil {
		return Store{}, err
	}
	dekNonce, wrapped, err := seal(kek, dek, []byte(dekAADPrefix+keyID))
	if err != nil {
		return Store{}, err
	}
	if len(wrapped) != 48 {
		return Store{}, ErrEnvelope
	}
	nonce, ct, err := seal(dek, []byte(clientID+"\x00"+apiKey), []byte(keyID))
	if err != nil {
		return Store{}, err
	}
	sum := sha256.Sum256([]byte(apiKey))
	return Store{
		Version: 2, KeyID: keyID,
		Nonce: nonce, Ciphertext: ct,
		WrappedDEK: wrapped, DEKNonce: dekNonce, Fingerprint: sum[:],
	}, nil
}

// OpenBlob opens a nonce-plus-ciphertext pair. AAD is keyID.
// Integration and catalog rows use this shape. It does not dial anything.
func OpenBlob(kek []byte, keyID string, nonce, ciphertext []byte) ([]byte, error) {
	return open(kek, nonce, ciphertext, []byte(keyID))
}

// SealBlob is the matching writer for tests.
func SealBlob(kek []byte, keyID string, plain []byte) (nonce, ciphertext []byte, err error) {
	return seal(kek, plain, []byte(keyID))
}

func openStore(kek []byte, env Store) (Secret, error) {
	switch env.Version {
	case 1:
		plain, err := open(kek, env.Nonce, env.Ciphertext, []byte(env.KeyID))
		if err != nil {
			return Secret{}, ErrEnvelope
		}
		apiKey := string(plain)
		if !fingerprintOK(env.Fingerprint, apiKey) {
			return Secret{}, ErrEnvelope
		}
		return Secret{ClientID: env.ClientID, APIKey: apiKey}, nil
	case 2:
		if len(env.WrappedDEK) != 48 || len(env.DEKNonce) != 12 {
			return Secret{}, ErrEnvelope
		}
		dek, err := open(kek, env.DEKNonce, env.WrappedDEK, []byte(dekAADPrefix+env.KeyID))
		if err != nil || len(dek) != 32 {
			return Secret{}, ErrEnvelope
		}
		plain, err := open(dek, env.Nonce, env.Ciphertext, []byte(env.KeyID))
		if err != nil {
			return Secret{}, ErrEnvelope
		}
		clientID, apiKey, ok := splitNUL(string(plain))
		if !ok || !fingerprintOK(env.Fingerprint, apiKey) {
			return Secret{}, ErrEnvelope
		}
		return Secret{ClientID: clientID, APIKey: apiKey}, nil
	default:
		return Secret{}, ErrEnvelope
	}
}

func fingerprintOK(got []byte, apiKey string) bool {
	if len(got) != 32 {
		return false
	}
	sum := sha256.Sum256([]byte(apiKey))
	for i := range sum {
		if sum[i] != got[i] {
			return false
		}
	}
	return true
}

func splitNUL(plain string) (string, string, bool) {
	i := strings.IndexByte(plain, 0)
	if i <= 0 || i == len(plain)-1 {
		return "", "", false
	}
	return plain[:i], plain[i+1:], true
}

func seal(key, plain, aad []byte) (nonce, ciphertext []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return nonce, gcm.Seal(nil, nonce, plain, aad), nil
}

func open(key, nonce, ciphertext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, ErrEnvelope
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}
