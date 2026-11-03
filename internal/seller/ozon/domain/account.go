package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// PhysicalAccountKey survives key rotation and is shared across tenants that
// use the same Seller account. It never includes the API key or tenant identity.
func PhysicalAccountKey(clientID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(clientID)))
	return "ozon-client:" + hex.EncodeToString(sum[:])
}
