package domain

import (
	"bytes"
	"strconv"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

// SourceRoleGrant is a grant body: the target account id.
type SourceRoleGrant struct {
	UserID int64
}

// DecodeSourceRoleGrant requires userId as an unquoted positive integer and
// rejects every other field. A quoted number is invalid: the admin UI always
// sends account ids as JSON numbers.
func DecodeSourceRoleGrant(body []byte) (SourceRoleGrant, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"userId"}) || !requireKeys(raw, []string{"userId"}) {
		return SourceRoleGrant{}, invalid()
	}
	value := bytes.TrimSpace(raw["userId"])
	if len(value) == 0 || value[0] == '"' || bytes.Equal(value, []byte("null")) {
		return SourceRoleGrant{}, fail(contract.KindValidation, "请选择要授权的账号")
	}
	id, err := strconv.ParseInt(string(value), 10, 64)
	if err != nil || id <= 0 {
		return SourceRoleGrant{}, fail(contract.KindValidation, "请选择要授权的账号")
	}
	return SourceRoleGrant{UserID: id}, nil
}
