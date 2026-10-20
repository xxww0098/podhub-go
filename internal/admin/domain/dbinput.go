package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

// NormalizedDb is an upsert body after trim and bounds checks.
type NormalizedDb = supcontract.NormalizedDb

// DecodeSupplierDb requires the fields that have no serde default.
// acceptsDelegate and accountEmail may be omitted.
func DecodeSupplierDb(body []byte) (NormalizedDb, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{
		"name", "country", "contact", "internalNote", "listed", "icon",
		"acceptsDelegate", "template", "viewPrefs", "accountEmail",
	}) || !requireKeys(raw, []string{
		"name", "country", "contact", "internalNote", "listed", "icon", "template", "viewPrefs",
	}) {
		return NormalizedDb{}, invalid()
	}
	var out NormalizedDb
	var name, country, contact, note, icon string
	if !unmarshal(raw["name"], &name) || !unmarshal(raw["country"], &country) ||
		!unmarshal(raw["contact"], &contact) || !unmarshal(raw["internalNote"], &note) ||
		!unmarshal(raw["icon"], &icon) || !unmarshal(raw["listed"], &out.Listed) {
		return NormalizedDb{}, invalid()
	}
	if raw["acceptsDelegate"] != nil {
		if !unmarshal(raw["acceptsDelegate"], &out.AcceptsDelegate) {
			return NormalizedDb{}, invalid()
		}
	}
	if bytes.Equal(bytes.TrimSpace(raw["template"]), []byte("null")) {
		out.Template = ""
	} else {
		var template string
		if !unmarshal(raw["template"], &template) {
			return NormalizedDb{}, invalid()
		}
		out.Template = strings.TrimSpace(template)
	}
	if bytes.Equal(bytes.TrimSpace(raw["viewPrefs"]), []byte("null")) {
		out.KeepViewPrefs = true
		out.ViewPrefs = json.RawMessage(`{}`)
	} else {
		if !json.Valid(raw["viewPrefs"]) {
			return NormalizedDb{}, invalid()
		}
		out.ViewPrefs = append(json.RawMessage(nil), raw["viewPrefs"]...)
	}
	if raw["accountEmail"] != nil && !bytes.Equal(bytes.TrimSpace(raw["accountEmail"]), []byte("null")) {
		var email string
		if !unmarshal(raw["accountEmail"], &email) {
			return NormalizedDb{}, invalid()
		}
		email = strings.ToLower(strings.TrimSpace(email))
		if email != "" {
			if len(email) > MaxEmailChars || !EmailShaped(email) {
				return NormalizedDb{}, fail(contract.KindValidation, "厂家登录邮箱无效")
			}
			out.AccountEmail = &email
		}
	}
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > MaxNameChars {
		return NormalizedDb{}, fail(contract.KindValidation, "名称需为 1–80 个字符")
	}
	country = strings.ToUpper(strings.TrimSpace(country))
	if country != "" && !twoLetters(country) {
		return NormalizedDb{}, fail(contract.KindValidation, "国家/地区需为空或两位字母代码")
	}
	contact = strings.TrimSpace(contact)
	if utf8.RuneCountInString(contact) > MaxTextChars {
		return NormalizedDb{}, fail(contract.KindValidation, "联系方式不能超过 255 个字符")
	}
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > MaxNoteChars {
		return NormalizedDb{}, fail(contract.KindValidation, "内部备注不能超过 2000 个字符")
	}
	icon = strings.TrimSpace(icon)
	if utf8.RuneCountInString(icon) > 16 {
		return NormalizedDb{}, fail(contract.KindValidation, "图标不能超过 16 个字符")
	}
	switch out.Template {
	case "", "factory":
	default:
		return NormalizedDb{}, fail(contract.KindValidation, "未知的建库模板")
	}
	if !out.KeepViewPrefs {
		var compact bytes.Buffer
		if err := json.Compact(&compact, out.ViewPrefs); err != nil || compact.Len() > MaxViewPrefsBytes {
			return NormalizedDb{}, fail(contract.KindValidation, "视图偏好过大")
		}
		out.ViewPrefs = append(json.RawMessage(nil), compact.Bytes()...)
	}
	out.Name, out.Country, out.Contact, out.InternalNote, out.Icon = name, country, contact, note, icon
	return out, nil
}

func twoLetters(s string) bool {
	if len(s) != 2 {
		return false
	}
	for i := 0; i < 2; i++ {
		if s[i] < 'A' || s[i] > 'Z' {
			return false
		}
	}
	return true
}

func fail(kind, message string) *contract.Fail {
	return &contract.Fail{Kind: kind, Message: message}
}

func invalid() *contract.Fail {
	return fail(contract.KindValidation, "请求格式无效")
}

// PropSeed is one factory attribute inserted with the new source.
type PropSeed = supcontract.PropSeed

// FactoryProps is the factory template, positions 0..4.
func FactoryProps(ids []string) ([]PropSeed, error) {
	if len(ids) != 5 {
		return nil, invalid()
	}
	empty := json.RawMessage(`[]`)
	coop := json.RawMessage(`[{"value":"dropship","label":"一件代发"},{"value":"oem","label":"批量代工"},{"value":"odm","label":"贴牌定制"}]`)
	settle := json.RawMessage(`[{"value":"prepaid","label":"款到发货"},{"value":"monthly","label":"月结"}]`)
	return []PropSeed{
		{PropID: ids[0], Name: "主营类目", Type: "text", Options: empty, Position: 0, SellerVisible: true},
		{PropID: ids[1], Name: "产地", Type: "text", Options: empty, Position: 1, SellerVisible: true},
		{PropID: ids[2], Name: "起订量", Type: "number", Options: empty, Position: 2, SellerVisible: true},
		{PropID: ids[3], Name: "合作模式", Type: "select", Options: coop, Position: 3, SellerVisible: false},
		{PropID: ids[4], Name: "结算方式", Type: "select", Options: settle, Position: 4, SellerVisible: false},
	}, nil
}
