package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

// PropOption is one select choice. JSON field order is value then label.
type PropOption = supcontract.PropOption

// NormalizedProp is a property upsert. Position nil means auto on create
// and keep-current on update.
type NormalizedProp = supcontract.NormalizedProp

// DecodeProp requires position to be present (null allowed). Omitting it
// is 请求格式无效. The cloud test that omits position is recorded as unresolved.
func DecodeProp(body []byte) (NormalizedProp, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"name", "type", "options", "position", "sellerVisible"}) ||
		!requireKeys(raw, []string{"name", "type", "options", "position", "sellerVisible"}) {
		return NormalizedProp{}, invalid()
	}
	var name, typ string
	if !unmarshal(raw["name"], &name) || !unmarshal(raw["type"], &typ) || !PropTypes[typ] {
		return NormalizedProp{}, invalid()
	}
	var options []PropOption
	if !unmarshal(raw["options"], &options) {
		return NormalizedProp{}, invalid()
	}
	if options == nil {
		options = []PropOption{}
	}
	var position *int64
	if !bytes.Equal(bytes.TrimSpace(raw["position"]), []byte("null")) {
		n, ok := parseInt(raw["position"])
		if !ok {
			return NormalizedProp{}, invalid()
		}
		if n < 0 {
			return NormalizedProp{}, fail(contract.KindValidation, "position 不能为负")
		}
		position = &n
	}
	var visible bool
	if !unmarshal(raw["sellerVisible"], &visible) {
		return NormalizedProp{}, invalid()
	}
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > MaxShortChars {
		return NormalizedProp{}, fail(contract.KindValidation, "名称需为 1–64 个字符")
	}
	if len(options) > MaxOptions {
		return NormalizedProp{}, fail(contract.KindValidation, "选项最多 60 项")
	}
	for i := range options {
		options[i].Value = strings.TrimSpace(options[i].Value)
		options[i].Label = strings.TrimSpace(options[i].Label)
		if options[i].Value == "" || options[i].Label == "" {
			return NormalizedProp{}, fail(contract.KindValidation, "选项值与选项名不能为空")
		}
		if utf8.RuneCountInString(options[i].Value) > MaxShortChars || utf8.RuneCountInString(options[i].Label) > MaxShortChars {
			return NormalizedProp{}, fail(contract.KindValidation, "选项值与选项名不能超过 64 个字符")
		}
	}
	if (typ == "select" || typ == "multi_select") && len(options) == 0 {
		return NormalizedProp{}, fail(contract.KindValidation, "选择型属性至少需要一个选项")
	}
	return NormalizedProp{Name: name, Type: typ, Options: options, Position: position, SellerVisible: visible}, nil
}

func parseInt(raw json.RawMessage) (int64, bool) {
	var n json.Number
	if !unmarshal(raw, &n) {
		return 0, false
	}
	v, err := strconv.ParseInt(n.String(), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// OptionsJSON encodes choices with value before label.
func OptionsJSON(options []PropOption) json.RawMessage { return supcontract.OptionsJSON(options) }
