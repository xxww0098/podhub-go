package domain

import (
	"encoding/json"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

func strictObject(body []byte) (map[string]json.RawMessage, error) {
	return corecontract.StrictObject(body)
}

func hasOnly(raw map[string]json.RawMessage, allow []string) bool {
	return corecontract.HasOnly(raw, allow)
}

func requireKeys(raw map[string]json.RawMessage, keys []string) bool {
	return corecontract.RequireKeys(raw, keys)
}

func unmarshal(raw json.RawMessage, dest any) bool {
	return corecontract.Unmarshal(raw, dest)
}

// JSONText encodes v with HTML left intact and no trailing newline.
func JSONText(v any) string { return corecontract.JSONText(v) }
