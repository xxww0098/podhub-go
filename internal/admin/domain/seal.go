package domain

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"io"
)

// KeySHA256 is the AES-256 key for a trimmed secret.
func KeySHA256(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

// Seal encrypts plain with AES-256-GCM. nonce is 12 bytes. The ciphertext
// includes the GCM tag.
func Seal(key, aad, plain []byte) (nonce, out []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return nonce, gcm.Seal(nil, nonce, plain, aad), nil
}

// Open decrypts. AAD must match the seal.
func Open(key, aad, nonce, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, aes.KeySizeError(len(nonce))
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}
