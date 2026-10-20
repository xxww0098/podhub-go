package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

const (
	createFingerprintVersion = "podhub-listing-row-create-v1"
	associationVersion       = "podhub-listing-association-v1"
)

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

// Association is the batch id and the PHM- model value for one design.
type Association struct {
	ID    string
	Model string
}

// AssociationIdentity derives the shared batch key. sourceSHA must be 64 hex
// digits, optional sha256: prefix. Empty source or group is refused.
func AssociationIdentity(orgID int64, sourceID, variantGroup, sourceSHA string) (Association, string) {
	sourceID = strings.TrimSpace(sourceID)
	variantGroup = strings.TrimSpace(variantGroup)
	if sourceID == "" || variantGroup == "" {
		return Association{}, "同款关联需要非空的货源库编号与款号"
	}
	hexDigest, ok := hexSHA(sourceSHA)
	if !ok {
		return Association{}, "source.sha256 必须是 64 位十六进制摘要"
	}
	canonical := fmt.Sprintf("%s\x00%d\x00%s\x00%s\x00%s", associationVersion, orgID, sourceID, variantGroup, hexDigest)
	return Association{
		ID:    derivedUUID(canonical, "association"),
		Model: "PHM-" + digestHex(canonical, "model")[:16],
	}, ""
}

func digestHex(canonical, purpose string) string {
	sum := sha256.Sum256([]byte(canonical + "\x00" + purpose))
	return hex.EncodeToString(sum[:])
}

func derivedUUID(canonical, purpose string) string {
	sum := sha256.Sum256([]byte(canonical + "\x00" + purpose))
	b := make([]byte, 16)
	copy(b, sum[:16])
	b[6] = (b[6] & 0x0f) | 0x80
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func hexSHA(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.TrimPrefix(trimmed, "sha256:")
	if len(trimmed) != 64 {
		return "", false
	}
	for _, r := range trimmed {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return "", false
		}
	}
	return strings.ToLower(trimmed), true
}
