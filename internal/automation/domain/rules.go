package domain

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

const (
	maxNameRunes     = 120
	maxAssetItems    = 500
	maxRendererBytes = 64
	sha256HexLen     = 64
	expiresMin       = 1
	expiresMax       = 3650
	tokenPrefixLen   = 12
)

// ItemInput is one asset row after the handler has decoded JSON.
// RuntimeID nil stores SQL NULL. Key is filled by CleanItems.
type ItemInput struct {
	FileName  string
	SHA256    string
	SizeBytes int64
	RuntimeID *string
	Key       string
}

// CleanName trims and enforces the 120-scalar limit.
func CleanName(name string) (string, *contract.Fault) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxNameRunes {
		return "", contract.Validation(contract.MsgBadName)
	}
	return name, nil
}

// CleanItems copies items in request order. More than 500 is rejected
// before per-item checks. Negative sizes become 0. There is no upper bound.
func CleanItems(items []ItemInput) ([]ItemInput, *contract.Fault) {
	if len(items) > maxAssetItems {
		return nil, contract.Validation(contract.MsgTooManyItems)
	}
	out := make([]ItemInput, len(items))
	for i, item := range items {
		file := strings.TrimSpace(item.FileName)
		sum := strings.ToLower(strings.TrimSpace(item.SHA256))
		if file == "" || len(sum) != sha256HexLen || !hex64(sum) {
			return nil, contract.Validation(contract.MsgBadItem)
		}
		size := item.SizeBytes
		if size < 0 {
			size = 0
		}
		out[i] = ItemInput{
			FileName: file, SHA256: sum, SizeBytes: size,
			RuntimeID: item.RuntimeID, Key: "local:" + sum + ":" + file,
		}
	}
	return out, nil
}

func hex64(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// CleanRenderer rejects a blank trim or an original byte length over 64.
func CleanRenderer(raw string) (string, *contract.Fault) {
	if strings.TrimSpace(raw) == "" || len(raw) > maxRendererBytes {
		return "", contract.Validation(contract.MsgBadRenderer)
	}
	return strings.TrimSpace(raw), nil
}

// CleanExpiry accepts a missing deadline. A present value must be 1..=3650.
func CleanExpiry(days *int64) *contract.Fault {
	if days == nil {
		return nil
	}
	if *days < expiresMin || *days > expiresMax {
		return contract.Validation(contract.MsgBadExpiry)
	}
	return nil
}

// ClampLimit applies unwrap_or(4).clamp(1, 8).
func ClampLimit(v *int64) int64 {
	n := ClaimLimitDefault
	if v != nil {
		n = *v
	}
	if n < ClaimLimitMin {
		return ClaimLimitMin
	}
	if n > ClaimLimitMax {
		return ClaimLimitMax
	}
	return n
}

// ParseID accepts the same textual forms as uuid::Uuid::parse_str that
// google/uuid.Parse accepts (hyphenated, urn, braced, 32 hex).
func ParseID(raw string) (string, bool) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return "", false
	}
	return id.String(), true
}

// RuntimeLive is the process-clock comparison, including equality at 45s.
func RuntimeLive(nowMS, heartbeatMS int64) bool {
	return nowMS-heartbeatMS <= RuntimeStaleMillis
}

// CleanStatus accepts the three terminal byte strings and nothing else.
func CleanStatus(status string) (string, *contract.Fault) {
	switch status {
	case StatusCompleted, StatusFailed, StatusCanceled:
		return status, nil
	default:
		return "", contract.Validation(contract.MsgBadStatus)
	}
}

// Delegate keeps the first occurrence of each workspace action the session
// role may grant. The error message uses the raw element, not the trim.
func Delegate(role string, raws []string) ([]string, *contract.Fault) {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(raws))
	for _, raw := range raws {
		stored, cap, ok := actionCapability(raw)
		if !ok {
			return nil, contract.Validation(contract.MsgUnknownAction + raw)
		}
		if cap == "" || !allows(role, cap, false) {
			return nil, contract.Validation(contract.MsgCannotDelegate + raw)
		}
		if _, dup := seen[stored]; dup {
			continue
		}
		seen[stored] = struct{}{}
		out = append(out, stored)
	}
	if len(out) == 0 {
		return nil, contract.Validation(contract.MsgNoAction)
	}
	return out, nil
}

// LiveAllows is the second check inside the grant transaction.
// An unknown stored role is viewer, matching WorkspaceRole::from_stored.
func LiveAllows(storedRole, action string) bool {
	_, cap, ok := actionCapability(action)
	if !ok || cap == "" {
		return false
	}
	return allows(storedRole, cap, true)
}

func allows(role, cap string, unknownIsViewer bool) bool {
	parsed, ok := access.ParseWorkspace(role)
	if !ok {
		if !unknownIsViewer {
			return false
		}
		parsed = "viewer"
	}
	switch cap {
	case "read":
		return true
	case "prepare":
		return parsed != "viewer"
	case "submit":
		return parsed == "owner" || parsed == "manager" || parsed == "operator"
	default:
		return false
	}
}

func actionCapability(raw string) (stored, cap string, ok bool) {
	switch strings.TrimSpace(raw) {
	case "read":
		return "read", "read", true
	case "catalog:read":
		return "catalog:read", "read", true
	case "prepare":
		return "prepare", "prepare", true
	case "cards:write":
		return "cards:write", "prepare", true
	case "submit":
		return "submit", "submit", true
	case "supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price":
		return strings.TrimSpace(raw), "", true
	default:
		return "", "", false
	}
}

// MintToken is opa_ plus 32 url-safe bytes, prefix of 12, SHA-256 hex.
func MintToken(r io.Reader) (token, prefix, hash string, err error) {
	var buf [32]byte
	if _, err = io.ReadFull(r, buf[:]); err != nil {
		return "", "", "", err
	}
	token = "opa_" + base64.RawURLEncoding.EncodeToString(buf[:])
	if len(token) < tokenPrefixLen {
		return "", "", "", io.ErrUnexpectedEOF
	}
	prefix = token[:tokenPrefixLen]
	sum := sha256.Sum256([]byte(token))
	hash = hex.EncodeToString(sum[:])
	return token, prefix, hash, nil
}
