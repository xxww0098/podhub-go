package domain

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxRebateBps     int64 = 10000
	maxMinOrderCents int64 = 100_000_000
	maxValidityDays  int64 = 3650
	inviteAlphabet         = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
)

var reservedInvite = map[string]bool{
	"PODHUB": true, "PODX": true, "OZONPOD": true, "ADMIN": true,
	"SUPPORT": true, "OFFICIAL": true, "SYSTEM": true,
}

// PolicyInput is the rebate policy body.
type PolicyInput struct {
	DefaultRebateBps        int64
	MinOrderCents           int64
	AttributionValidityDays int64
	MinWithdrawCents        int64
}

type policyBody struct {
	DefaultRebateBps        *int64 `json:"default_rebate_bps"`
	MinOrderCents           *int64 `json:"min_order_cents"`
	AttributionValidityDays *int64 `json:"attribution_validity_days"`
	MinWithdrawCents        *int64 `json:"min_withdraw_cents"`
}

// ParsePolicy requires the four integers and checks the documented ranges.
func ParsePolicy(raw []byte) (PolicyInput, error) {
	var body policyBody
	if err := DecodeJSON(raw, &body); err != nil {
		return PolicyInput{}, err
	}
	if body.DefaultRebateBps == nil || body.MinOrderCents == nil || body.AttributionValidityDays == nil || body.MinWithdrawCents == nil {
		return PolicyInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	in := PolicyInput{
		DefaultRebateBps: *body.DefaultRebateBps, MinOrderCents: *body.MinOrderCents,
		AttributionValidityDays: *body.AttributionValidityDays, MinWithdrawCents: *body.MinWithdrawCents,
	}
	if in.DefaultRebateBps < 0 || in.DefaultRebateBps > maxRebateBps {
		return PolicyInput{}, Fail(400, "VALIDATION", "返点比例需在 0-10000 bps 之间")
	}
	if in.MinOrderCents < 0 || in.MinOrderCents > maxMinOrderCents {
		return PolicyInput{}, Fail(400, "VALIDATION", "合格首单门槛需在 0-100000000 分之间")
	}
	if in.MinWithdrawCents < 0 || in.MinWithdrawCents > maxMinOrderCents {
		return PolicyInput{}, Fail(400, "VALIDATION", "最低提现需在 0-100000000 分之间")
	}
	if in.AttributionValidityDays < 0 || in.AttributionValidityDays > maxValidityDays {
		return PolicyInput{}, Fail(400, "VALIDATION", "归因有效期需在 0-3650 天之间")
	}
	return in, nil
}

// PolicySummary is the audit sentence.
func PolicySummary(in PolicyInput) string {
	return "代理政策：" + itoa64(in.DefaultRebateBps) + " bps / 合格首单 " + itoa64(in.MinOrderCents) +
		" 分 / 归因有效期 " + itoa64(in.AttributionValidityDays) + " 天 / 最低提现 " + itoa64(in.MinWithdrawCents) + " 分"
}

type createAgentBody struct {
	Email      *string `json:"email"`
	InviteCode *string `json:"invite_code"`
}

// ParseCreateAgent trims the email. An empty email is a validation error.
func ParseCreateAgent(raw []byte) (email string, invite *string, err error) {
	var body createAgentBody
	if err = DecodeJSON(raw, &body); err != nil {
		return "", nil, err
	}
	if body.Email == nil || strings.TrimSpace(*body.Email) == "" {
		return "", nil, Fail(400, "VALIDATION", "请填写代理账号邮箱")
	}
	email = strings.ToLower(strings.TrimSpace(*body.Email))
	if body.InviteCode != nil && strings.TrimSpace(*body.InviteCode) != "" {
		code, err := NormalizeCustomInvite(*body.InviteCode)
		if err != nil {
			return "", nil, err
		}
		invite = &code
	}
	return email, invite, nil
}

type updateAgentBody struct {
	InviteCode *string `json:"invite_code"`
	Status     *string `json:"status"`
}

// ParseUpdateAgent requires status active or disabled.
func ParseUpdateAgent(raw []byte) (status string, invite *string, keep bool, err error) {
	var body updateAgentBody
	if err = DecodeJSON(raw, &body); err != nil {
		return "", nil, false, err
	}
	if body.Status == nil {
		return "", nil, false, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	status = strings.TrimSpace(*body.Status)
	if status != "active" && status != "disabled" {
		return "", nil, false, Fail(400, "VALIDATION", "代理状态无效")
	}
	if body.InviteCode == nil || strings.TrimSpace(*body.InviteCode) == "" {
		return status, nil, true, nil
	}
	code, err := NormalizeCustomInvite(*body.InviteCode)
	if err != nil {
		return "", nil, false, err
	}
	return status, &code, false, nil
}

// NormalizeCustomInvite is resolve_invite_code for a caller-supplied code.
func NormalizeCustomInvite(raw string) (string, error) {
	code, ok := normalizeInvite(raw)
	if !ok {
		return "", Fail(400, "VALIDATION", "邀请码需为 4-32 位字母或数字")
	}
	if len(code) < 8 {
		return "", Fail(400, "VALIDATION", "自定义邀请码至少 8 位")
	}
	if reservedInvite[code] {
		return "", Fail(400, "VALIDATION", "该邀请码为保留字")
	}
	return code, nil
}

func normalizeInvite(raw string) (string, bool) {
	code := strings.TrimSpace(raw)
	code = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			return r - ('a' - 'A')
		}
		return r
	}, code)
	if len(code) < 4 || len(code) > 32 {
		return "", false
	}
	for i := 0; i < len(code); i++ {
		c := code[i]
		if (c < 'A' || c > 'Z') && (c < '0' || c > '9') {
			return "", false
		}
	}
	return code, true
}

// InviteAlphabet is the generated-code alphabet.
func InviteAlphabet() string { return inviteAlphabet }

// WithdrawalStatus accepts pending, paid, rejected, or empty.
func WithdrawalStatus(raw string) (string, bool, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false, nil
	}
	switch trimmed {
	case "pending", "paid", "rejected":
		return trimmed, true, nil
	default:
		return "", false, Fail(400, "VALIDATION", "未知提现状态")
	}
}

type payBody struct {
	Reference *string `json:"reference"`
}

// ParsePay allows an omitted or blank reference. An empty body is invalid JSON.
func ParsePay(raw []byte) (*string, error) {
	var body payBody
	if err := DecodeJSON(raw, &body); err != nil {
		return nil, err
	}
	if body.Reference == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*body.Reference)
	if trimmed == "" {
		return nil, nil
	}
	return &trimmed, nil
}

type rejectBody struct {
	Reason *string `json:"reason"`
}

// ParseReject requires a non-blank reason.
func ParseReject(raw []byte) (string, error) {
	var body rejectBody
	if err := DecodeJSON(raw, &body); err != nil {
		return "", err
	}
	if body.Reason == nil {
		return "", Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	reason := strings.TrimSpace(*body.Reason)
	if reason == "" {
		return "", Fail(400, "VALIDATION", "拒绝原因必填")
	}
	return reason, nil
}

// CSVInt is the unquoted integer cell. Negatives keep the minus sign.
func CSVInt(n int64) string { return strconv.FormatInt(n, 10) }

// CSVField quotes and neutralizes one text cell.
func CSVField(value string) string {
	formula := csvFormula(value)
	needs := formula
	if !needs {
		for _, r := range value {
			if r == ',' || r == '"' || r == '\n' || r == '\r' {
				needs = true
				break
			}
		}
	}
	if !needs {
		return value
	}
	body := strings.ReplaceAll(value, `"`, `""`)
	if formula {
		body = "'" + body
	}
	return `"` + body + `"`
}

// csvFormula strips a leading run of whitespace that is not a control character,
// then treats a control, '=', '+', '-', '@', or U+FEFF as a formula.
func csvFormula(value string) bool {
	i := 0
	for i < len(value) {
		r, size := utf8.DecodeRuneInString(value[i:])
		if unicode.IsSpace(r) && !unicode.IsControl(r) {
			i += size
			continue
		}
		return unicode.IsControl(r) || r == '=' || r == '+' || r == '-' || r == '@' || r == '\uFEFF'
	}
	return false
}
