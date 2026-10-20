package domain

import (
	"crypto/sha256"
	"encoding/hex"
)

// SessionHash is SHA-256 of the session token, hex encoded, matching identity.hashToken.
func SessionHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
