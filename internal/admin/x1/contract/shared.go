package contract

import (
	"encoding/json"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

// Limits copied from the supplier catalog bounds. admin/domain keeps the same numbers.
const (
	MaxNameChars = 80
	MaxNoteChars = 2000
)

type (
	SupplierDb = corecontract.SupplierDb
	Prop       = corecontract.Prop
)

func fail(kind, message string) *outcome.Fail {
	return &outcome.Fail{Kind: kind, Message: message}
}

func invalid() *outcome.Fail {
	return fail(outcome.KindValidation, "请求格式无效")
}

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
