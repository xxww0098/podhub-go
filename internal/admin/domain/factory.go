package domain

import (
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

// DecodeFactory validates factory details; only creation accepts a login email.
func DecodeFactory(body []byte, creating bool) (FactoryInput, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"name", "country", "contact", "internal_note", "icon", "account_email"}) ||
		!requireKeys(raw, []string{"name", "country", "contact", "internal_note", "icon"}) {
		return FactoryInput{}, invalid()
	}
	var in FactoryInput
	if !unmarshal(raw["name"], &in.Name) || !unmarshal(raw["country"], &in.Country) ||
		!unmarshal(raw["contact"], &in.Contact) || !unmarshal(raw["internal_note"], &in.InternalNote) ||
		!unmarshal(raw["icon"], &in.Icon) {
		return FactoryInput{}, invalid()
	}
	if creating {
		if !unmarshal(raw["account_email"], &in.AccountEmail) {
			return FactoryInput{}, fail(contract.KindValidation, "请填写工厂登录邮箱")
		}
		in.AccountEmail = strings.ToLower(strings.TrimSpace(in.AccountEmail))
		if len(in.AccountEmail) > MaxEmailChars || !EmailShaped(in.AccountEmail) {
			return FactoryInput{}, fail(contract.KindValidation, "工厂登录邮箱无效")
		}
	} else if raw["account_email"] != nil {
		return FactoryInput{}, invalid()
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Country = strings.ToUpper(strings.TrimSpace(in.Country))
	in.Contact = strings.TrimSpace(in.Contact)
	in.InternalNote = strings.TrimSpace(in.InternalNote)
	in.Icon = strings.TrimSpace(in.Icon)
	if n := utf8.RuneCountInString(in.Name); n < 1 || n > MaxNameChars {
		return FactoryInput{}, fail(contract.KindValidation, "名称需为 1–80 个字符")
	}
	if in.Country != "" && !twoLetters(in.Country) {
		return FactoryInput{}, fail(contract.KindValidation, "国家/地区需为空或两位字母代码")
	}
	if utf8.RuneCountInString(in.Contact) > MaxTextChars || utf8.RuneCountInString(in.InternalNote) > MaxNoteChars || utf8.RuneCountInString(in.Icon) > 16 {
		return FactoryInput{}, fail(contract.KindValidation, "工厂资料过长")
	}
	return in, nil
}
