package domain

import (
	"bytes"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

// NormalizedAccount is a create-account body.
type NormalizedAccount = supcontract.NormalizedAccount

// DecodeAccount requires sourceId and email. name and password may be omitted.
func DecodeAccount(body []byte) (NormalizedAccount, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"sourceId", "email", "name", "password"}) ||
		!requireKeys(raw, []string{"sourceId", "email"}) {
		return NormalizedAccount{}, invalid()
	}
	var source, email string
	if !unmarshal(raw["sourceId"], &source) || !unmarshal(raw["email"], &email) {
		return NormalizedAccount{}, invalid()
	}
	source = strings.TrimSpace(source)
	if source == "" {
		return NormalizedAccount{}, fail(contract.KindValidation, "请选择厂家")
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if len(email) > MaxEmailChars || !EmailShaped(email) {
		return NormalizedAccount{}, fail(contract.KindValidation, "邮箱无效")
	}
	var out NormalizedAccount
	out.SourceID = source
	out.Email = email
	if raw["name"] != nil && !bytes.Equal(bytes.TrimSpace(raw["name"]), []byte("null")) {
		var name string
		if !unmarshal(raw["name"], &name) {
			return NormalizedAccount{}, invalid()
		}
		name = strings.TrimSpace(name)
		if name != "" {
			out.Name = &name
		}
	}
	if raw["password"] != nil && !bytes.Equal(bytes.TrimSpace(raw["password"]), []byte("null")) {
		var password string
		if !unmarshal(raw["password"], &password) {
			return NormalizedAccount{}, invalid()
		}
		if password == "" {
			return NormalizedAccount{}, fail(contract.KindValidation, "密码不能为空")
		}
		if len(password) > MaxPasswordBytes {
			return NormalizedAccount{}, fail(contract.KindValidation, "密码过长")
		}
		out.Password = &password
	}
	return out, nil
}

// AccountPatch is a status and/or password change.
type AccountPatch = supcontract.AccountPatch

// DecodeAccountPatch reports empty when both fields are missing or null.
// Invalid JSON is not empty; the caller authenticates before rejecting it.
func DecodeAccountPatch(body []byte) (AccountPatch, bool, error) {
	raw, err := strictObject(body)
	if err != nil {
		return AccountPatch{}, false, invalid()
	}
	if !hasOnly(raw, []string{"status", "password"}) {
		return AccountPatch{}, false, invalid()
	}
	var out AccountPatch
	if raw["status"] != nil && !bytes.Equal(bytes.TrimSpace(raw["status"]), []byte("null")) {
		var status string
		if !unmarshal(raw["status"], &status) || (status != "active" && status != "disabled") {
			return AccountPatch{}, false, invalid()
		}
		out.Status = &status
	}
	if raw["password"] != nil && !bytes.Equal(bytes.TrimSpace(raw["password"]), []byte("null")) {
		var password string
		if !unmarshal(raw["password"], &password) {
			return AccountPatch{}, false, invalid()
		}
		if password == "" {
			return AccountPatch{}, false, fail(contract.KindValidation, "密码不能为空")
		}
		if len(password) > MaxPasswordBytes {
			return AccountPatch{}, false, fail(contract.KindValidation, "密码过长")
		}
		out.Password = &password
	}
	if out.Status == nil && out.Password == nil {
		return AccountPatch{}, true, nil
	}
	return out, false, nil
}

// PatchEmpty is the pre-auth check: a well-formed body with nothing to change.
func PatchEmpty(body []byte) bool {
	_, empty, err := DecodeAccountPatch(body)
	return err == nil && empty
}

// PatchWantsSuper is true when the body sets a password. Invalid JSON is not
// a password change; the handler authenticates as staff and then rejects it.
func PatchWantsSuper(body []byte) bool {
	in, empty, err := DecodeAccountPatch(body)
	return err == nil && !empty && in.Password != nil
}

// EmailLocal is the display name used when name is omitted.
func EmailLocal(email string) string {
	local, _, _ := strings.Cut(email, "@")
	if local == "" {
		return email
	}
	return local
}
