package domain

import (
	"strings"

	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

// Withdrawal is SupplierWithdrawalView. Blank optional fields are omitted.
type Withdrawal = supcontract.Withdrawal

// Prompt is SupplierPromptData. The type lives with the x1 contract.
type Prompt = x1contract.Prompt

// GrantView is ScopedAutomationGrantView. Time options serialize null.
type GrantView struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	ScopeKind    string    `json:"scopeKind"`
	SourceIDs    *[]string `json:"sourceIds"`
	Actions      []string  `json:"actions"`
	TokenPrefix  string    `json:"tokenPrefix"`
	CreatedAtMs  int64     `json:"createdAtMs"`
	ExpiresAtMs  *int64    `json:"expiresAtMs"`
	LastUsedAtMs *int64    `json:"lastUsedAtMs"`
	RevokedAtMs  *int64    `json:"revokedAtMs"`
}

// NormalizeStatus is the withdrawal list filter. Blank means no filter.
func NormalizeStatus(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	switch value {
	case "requested", "paid", "rejected":
		return value, nil
	default:
		return "", failMsg("提现状态无效")
	}
}

// DecodePay reads AdminFactoryWithdrawalPayRequest. The length check is separate.
func DecodePay(body []byte) (string, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"reference"}) || !requireKeys(raw, []string{"reference"}) {
		return "", failMsg("请求格式无效")
	}
	var reference string
	if !unmarshal(raw["reference"], &reference) {
		return "", failMsg("请求格式无效")
	}
	return reference, nil
}

// DecodeReject reads AdminFactoryWithdrawalRejectRequest.
func DecodeReject(body []byte) (string, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"reason"}) || !requireKeys(raw, []string{"reason"}) {
		return "", failMsg("请求格式无效")
	}
	var reason string
	if !unmarshal(raw["reason"], &reason) {
		return "", failMsg("请求格式无效")
	}
	return reason, nil
}

// Bounded trims and checks a 1..max rune length.
func Bounded(raw string, max int, message string) (string, error) {
	return supcontract.Bounded(raw, max, message)
}
