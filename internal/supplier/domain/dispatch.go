package domain

import (
	"strings"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

// Dispatch states the list filter accepts. rejected and cancelled are stored
// states but are not legal filter values.
const (
	StateDispatched = "dispatched"
	StateAccepted   = "accepted"
	StateShipped    = "shipped"
	StateRejected   = "rejected"
	StateCancelled  = "cancelled"
)

// FilterState accepts a missing or blank query as "all". Any other value must
// be one of the three live states, compared exactly.
func FilterState(raw string) (string, error) {
	state := strings.TrimSpace(raw)
	switch state {
	case "", StateDispatched, StateAccepted, StateShipped:
		return state, nil
	default:
		return "", contract.Fail(400, "validation", "未知的派发包状态")
	}
}

// Cursor is the keyset position. Empty means the first page.
type Cursor struct {
	NoDeadline bool
	Deadline   string
	ID         string
}

// DecodeCursor parses 0|{deadline}|{uuid} or 1||{uuid}.
func DecodeCursor(raw string) (Cursor, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return Cursor{}, nil
	}
	parts := strings.Split(text, "|")
	if len(parts) != 3 {
		return Cursor{}, contract.Fail(400, "validation", "分页游标无效")
	}
	id, err := uuid.Parse(parts[2])
	if err != nil {
		return Cursor{}, contract.Fail(400, "validation", "分页游标无效")
	}
	switch parts[0] {
	case "0":
		if strings.TrimSpace(parts[1]) == "" {
			return Cursor{}, contract.Fail(400, "validation", "分页游标无效")
		}
		return Cursor{Deadline: parts[1], ID: id.String()}, nil
	case "1":
		if strings.TrimSpace(parts[1]) != "" {
			return Cursor{}, contract.Fail(400, "validation", "分页游标无效")
		}
		return Cursor{NoDeadline: true, ID: id.String()}, nil
	default:
		return Cursor{}, contract.Fail(400, "validation", "分页游标无效")
	}
}

// EncodeCursor writes the keyset of the last row on a full page.
func EncodeCursor(deadline *string, id string) string {
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil {
		return ""
	}
	if deadline == nil {
		return "1||" + parsed.String()
	}
	return "0|" + *deadline + "|" + parsed.String()
}

// ParseUUID trims and parses. A bad id is the same not-found the query returns.
func ParseUUID(raw string) (string, error) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// RejectReason trims and bounds the reason. Empty and over-long are validation.
func RejectReason(raw string) (string, error) {
	reason := strings.TrimSpace(raw)
	if reason == "" {
		return "", contract.Fail(400, "validation", "请填写拒单原因")
	}
	if len([]rune(reason)) > 500 {
		return "", contract.Fail(400, "validation", "拒单原因不能超过 500 字")
	}
	return reason, nil
}

// ShipFields bounds the tracking number and the note. Both may be blank.
func ShipFields(tracking, note string) (string, string, error) {
	tracking = strings.TrimSpace(tracking)
	note = strings.TrimSpace(note)
	if len([]rune(tracking)) > 128 {
		return "", "", contract.Fail(400, "validation", "运单号不能超过 128 字")
	}
	if len([]rune(note)) > 500 {
		return "", "", contract.Fail(400, "validation", "备注不能超过 500 字")
	}
	return tracking, note, nil
}

// ActionsView is the detail projection, not an authorization decision.
func ActionsView(state string) (accept, reject, ship bool) {
	if state == StateDispatched {
		return true, true, false
	}
	if state == StateAccepted {
		return false, false, true
	}
	return false, false, false
}

// RuneLen is Unicode scalar count, matching Rust str::chars().count().
func RuneLen(s string) int { return len([]rune(s)) }
