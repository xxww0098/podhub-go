package domain

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

// SupplierActions are AutomationAction values with is_supplier.
var SupplierActions = []string{
	"supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price",
}

var knownActions = []string{
	"read", "prepare", "submit", "catalog:read", "cards:write",
	"supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price",
}

// GrantInput is a normalized CreateScopedAutomationGrantRequest.
// Sources nil means every source. An empty slice means none.
type GrantInput struct {
	Name    string
	Actions []string
	Expires *int64
	Sources *[]string
}

// DecodeGrant rejects unknown fields. expiresInDays and sourceIds may be absent.
func DecodeGrant(body []byte) (GrantInput, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"name", "actions", "expiresInDays", "sourceIds"}) || !requireKeys(raw, []string{"name", "actions"}) {
		return GrantInput{}, failMsg("请求格式无效")
	}
	var name string
	var actions []string
	if !unmarshal(raw["name"], &name) || !unmarshal(raw["actions"], &actions) || actions == nil {
		return GrantInput{}, failMsg("请求格式无效")
	}
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 120 {
		return GrantInput{}, failMsg("名称不能为空且不超过 120 字符")
	}
	var expires *int64
	if v, ok := raw["expiresInDays"]; ok && string(v) != "null" {
		n, ok := jsonNumber(v)
		if !ok || n < 1 || n > 3650 {
			return GrantInput{}, failMsg("有效期须在 1 到 3650 天之间")
		}
		expires = &n
	}
	var sources *[]string
	if v, ok := raw["sourceIds"]; ok && string(v) != "null" {
		var ids []string
		if !unmarshal(v, &ids) || ids == nil {
			return GrantInput{}, failMsg("源库范围无效，最多 200 个源库")
		}
		if len(ids) > 200 {
			return GrantInput{}, failMsg("源库范围无效，最多 200 个源库")
		}
		for _, id := range ids {
			if id == "" || utf8.RuneCountInString(id) > 200 || hasControl(id) {
				return GrantInput{}, failMsg("源库范围无效，最多 200 个源库")
			}
		}
		sort.Strings(ids)
		ids = dedupe(ids)
		sources = &ids
	}
	seen := map[string]struct{}{}
	var kept []string
	for _, action := range actions {
		if _, ok := seen[action]; ok {
			continue
		}
		seen[action] = struct{}{}
		if !contains(knownActions, action) {
			return GrantInput{}, failMsg("未知的授权动作")
		}
		if !contains(SupplierActions, action) {
			return GrantInput{}, failMsg("动作与授权范围不匹配")
		}
		kept = append(kept, action)
	}
	if len(kept) == 0 {
		return GrantInput{}, failMsg("至少选择一个授权动作")
	}
	return GrantInput{Name: name, Actions: kept, Expires: expires, Sources: sources}, nil
}

func jsonNumber(raw json.RawMessage) (int64, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var n json.Number
	if err := dec.Decode(&n); err != nil || dec.More() {
		return 0, false
	}
	v, err := n.Int64()
	return v, err == nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

func dedupe(sorted []string) []string {
	if len(sorted) == 0 {
		return sorted
	}
	out := sorted[:1]
	for _, s := range sorted[1:] {
		if s != out[len(out)-1] {
			out = append(out, s)
		}
	}
	return out
}

func failMsg(message string) *contract.Fail {
	return &contract.Fail{Kind: contract.KindValidation, Message: message}
}
