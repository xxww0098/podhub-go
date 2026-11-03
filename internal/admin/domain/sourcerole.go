package domain

import (
	"encoding/json"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

// Source grants use the public account identifier exposed by account pickers.
func DecodeSourceAccountGrant(body []byte) (string, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"account_uuid"}) || !requireKeys(raw, []string{"account_uuid"}) {
		return "", invalid()
	}
	var id string
	if err := json.Unmarshal(raw["account_uuid"], &id); err != nil {
		return "", invalid()
	}
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 128 {
		return "", fail(contract.KindValidation, "请选择要授权的账号")
	}
	return id, nil
}
