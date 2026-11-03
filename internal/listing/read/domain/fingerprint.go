package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const createFingerprintVersion = "podhub-listing-row-create-v1"

// CreateFingerprint is listing_core create_request_fingerprint.
// Empty association parts and a nil draft are empty fields. The client
// fingerprint is the untrimmed request value.
func CreateFingerprint(cardID, storeID, sha, fileName, associationID, modelValue, clientFingerprint, draftJSON string) string {
	canonical := strings.Join([]string{
		createFingerprintVersion, cardID, storeID, sha, fileName,
		associationID, modelValue, clientFingerprint, draftJSON,
	}, "\x00")
	sum := sha256.Sum256([]byte(canonical))
	return "sha256:" + hex.EncodeToString(sum[:])
}
