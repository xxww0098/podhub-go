package domain

import (
	"regexp"
	"strings"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

// inviteCode is agents_invite_code_shape. Lower case is rejected here.
// Nothing in the migration folds case, so this function does not either.
var inviteCode = regexp.MustCompile(`^[A-Z0-9]{4,32}$`)

// ValidateInviteCode reports whether code can be stored in agents.invite_code.
func ValidateInviteCode(code string) error {
	if !inviteCode.MatchString(code) {
		return contract.ErrInvalidShape
	}
	return nil
}

// NormalizeInviteCode is billing/agents.rs normalize_invite_code: trim, ASCII
// upper case, then [A-Z0-9]{4,32}. A false ok is the claim 400 邀请码无效
// before any agent row is loaded. Bytes outside ASCII are not folded.
func NormalizeInviteCode(raw string) (string, bool) {
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

// ParseAgentStatus accepts only agents_status_known. The migration has no
// transition SQL between active and disabled, so this package does not
// invent one.
func ParseAgentStatus(status string) error {
	switch status {
	case "active", "disabled":
		return nil
	default:
		return contract.ErrInvalidShape
	}
}
