package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// StoredInbox is the row load_inbox_event returns.
type StoredInbox struct {
	OrgID         int64
	UserID        int64
	Kind          string
	Payload       string
	SchemaVersion int32
}

// CompareInbox classifies a repeat delivery.
// replay is true when the stored row may be accepted again.
// reason is 同 id 异身份冲突 or 同 id 异内容冲突 when it must be rejected.
func CompareInbox(stored StoredInbox, incoming AcceptedEvent, orgID, userID int64) (replay bool, reason string) {
	if stored.Kind != incoming.Kind || stored.OrgID != orgID || stored.UserID != userID {
		return false, "同 id 异身份冲突"
	}
	if stored.SchemaVersion != incoming.SchemaVersion {
		return false, "同 id 异内容冲突"
	}
	switch incoming.Kind {
	case "billing.object-upload-usage.v1":
		if uploadTuple(stored.Payload) == uploadTuple(incoming.Payload) && uploadTuple(incoming.Payload) != "" {
			return true, ""
		}
		return false, "同 id 异内容冲突"
	case "desktop_error_log.v3":
		left, lok := projectV3(stored.Payload)
		right, rok := projectV3(incoming.Payload)
		if lok && rok && sha256Hex(left) == sha256Hex(right) {
			return true, ""
		}
		return false, "同 id 异内容冲突"
	default:
		if sha256Hex(stored.Payload) == sha256Hex(incoming.Payload) {
			return true, ""
		}
		return false, "同 id 异内容冲突"
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func uploadTuple(payload string) string {
	var body struct {
		Bytes       int64  `json:"bytes"`
		ObjectKey   string `json:"objectKey"`
		ContentHash string `json:"contentHash"`
	}
	if json.Unmarshal([]byte(payload), &body) != nil {
		return ""
	}
	return compactTuple(body.Bytes, body.ObjectKey, body.ContentHash)
}

func compactTuple(bytes int64, key, hash string) string {
	return rawInt(bytes).String() + "\n" + key + "\n" + hash
}

// projectV3 is the replay projection: the canonical payload this process
// stored. A failed parse is a mismatch.
func projectV3(payload string) (string, bool) {
	if _, err := parseObject(payload); err != nil {
		return "", false
	}
	return payload, true
}
