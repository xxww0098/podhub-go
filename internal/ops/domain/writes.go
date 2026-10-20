package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// ProductKey is ozon.product-mutation:{store}:{operation}.
func ProductKey(storeUUID, operationID string) string {
	return "ozon.product-mutation:" + storeUUID + ":" + operationID
}

// ChatKey hashes chat_id, a NUL, and the trimmed text.
func ChatKey(storeUUID, chatID, text string) string {
	sum := sha256.Sum256(append(append([]byte(chatID), 0), []byte(text)...))
	return "ozon.chat-send:" + storeUUID + ":" + hex.EncodeToString(sum[:])
}

// RequestHash is sha256:{hex} of store, NUL, and the stored request JSON.
func RequestHash(storeUUID string, requestJSON []byte) string {
	h := sha256.New()
	_, _ = h.Write([]byte(storeUUID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(requestJSON)
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

// Apply is the HTTP write state machine. Pairs outside the table are illegal.
func Apply(from, edge string) (string, bool) {
	switch from + "->" + edge {
	case "dispatching->settled":
		return "settled", true
	case "dispatching->result_unknown":
		return "result_unknown", true
	case "result_unknown->reconciled":
		return "reconciled", true
	case "result_unknown->conflict":
		return "conflict", true
	case "result_unknown->result_unknown":
		return "result_unknown", true
	default:
		return "", false
	}
}

// ProbeBackoff is 60, 120, 240, 480, then 900.
func ProbeBackoff(passes int) int {
	if passes < 0 {
		passes = 0
	}
	if passes > 4 {
		passes = 4
	}
	sec := 60 * (1 << passes)
	if sec > 900 {
		return 900
	}
	return sec
}

// OpsError is the ledger body for a decided refusal. Field order is error, code.
func OpsError(message, code string) []byte {
	raw, err := compact(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: message, Code: code})
	if err != nil {
		return []byte(`{"error":"","code":"internal"}`)
	}
	return raw
}

// ReplayView unwraps a settled 200 body. Unreadable receipts are not success.
func ReplayView(body []byte, dest any) error {
	return json.Unmarshal(body, dest)
}
