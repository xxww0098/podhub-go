package domain

import (
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

const (
	MaxNoteChars   = 1000
	MicrofenPerFen = 1_000_000
)

// NormalizeNote trims and rejects more than 1000 Unicode scalars.
func NormalizeNote(raw, label string) (string, error) {
	note := strings.TrimSpace(raw)
	if utf8.RuneCountInString(note) > MaxNoteChars {
		return "", contract.Validation(label + "不能超过 1000 个字符")
	}
	return note, nil
}

// NormalizeLineIDs parses line ids, drops duplicates, and keeps first-seen order.
func NormalizeLineIDs(raw []string) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, id := range raw {
		norm, ok := NormalizeUUID(id)
		if !ok {
			return nil, contract.Validation("lineIds 含无效行 id")
		}
		if seen[norm] {
			continue
		}
		seen[norm] = true
		out = append(out, norm)
	}
	return out, nil
}

// ResolveRequestedLines is orders_store::resolve_requested_lines.
// An empty request selects every dispatchable line, in that order.
func ResolveRequestedLines(dispatchable, requested []string) ([]string, error) {
	if len(requested) == 0 {
		out := make([]string, len(dispatchable))
		copy(out, dispatchable)
		return out, nil
	}
	selected := make([]string, 0, len(requested))
	for _, candidate := range dispatchable {
		if contains(requested, candidate) && !contains(selected, candidate) {
			selected = append(selected, candidate)
		}
	}
	var missing []string
	for _, id := range requested {
		if !contains(dispatchable, id) && !contains(missing, id) {
			missing = append(missing, id)
		}
	}
	if len(missing) == 0 {
		return selected, nil
	}
	return nil, contract.Unprocessable("所选行不可派发（未绑定厂家、缺已核验原图或已在途）：" + strings.Join(missing, ", "))
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// Microfen is quote::microfen. 1 fen is 1_000_000. Zero and overflow fail.
func Microfen(cents int64) (int64, error) {
	if cents <= 0 {
		return 0, contract.Conflict("结算金额超出范围")
	}
	if cents > (1<<63-1)/MicrofenPerFen {
		return 0, contract.Conflict("结算金额超出范围")
	}
	return cents * MicrofenPerFen, nil
}

// Receipt is the view of a receipt jsonb object. Empty strings are omitted.
// atMs is present only when the JSON value is a number.
type Receipt struct {
	TrackingNo string
	Note       string
	Reason     string
	RecordedBy string
	AtMs       *int64
}

// ReceiptView reads tracking_no, note, reason, recorded_by, and at_ms.
func ReceiptView(raw map[string]any) *Receipt {
	if raw == nil {
		return nil
	}
	out := &Receipt{
		TrackingNo: nonempty(raw["tracking_no"]),
		Note:       nonempty(raw["note"]),
		Reason:     nonempty(raw["reason"]),
		RecordedBy: nonempty(raw["recorded_by"]),
	}
	switch n := raw["at_ms"].(type) {
	case float64:
		v := int64(n)
		out.AtMs = &v
	case int64:
		v := n
		out.AtMs = &v
	}
	if out.TrackingNo == "" && out.Note == "" && out.Reason == "" && out.RecordedBy == "" && out.AtMs == nil {
		return &Receipt{}
	}
	return out
}

func nonempty(v any) string {
	s, _ := v.(string)
	if s == "" {
		return ""
	}
	return s
}

// SettleEdge is one named settlement transition.
type SettleEdge struct {
	Name string
	From string
	To   string
	Err  string
}

// SettleDispatch is settle_dispatch's state match. "" means no row (quote path).
func SettleDispatch(from string) (to string, err error) {
	switch from {
	case "", "none":
		return "settled", nil
	case "settled":
		return "settled", nil
	case "released":
		return "released", contract.Conflict("这笔冻结已退回，不能结算")
	case "held":
		return "settled", nil
	default:
		return from, contract.Conflict("结算状态异常")
	}
}

// CancelDecision is the admin cancel edge. actor is None, so no store_id guard.
type CancelDecision struct {
	Name            string
	State           string
	CancelRequested bool
	Recall          bool
	ReleaseHeld     bool
}

// AdminCancel refuses done and cancelled. Accepted or shipped packets only
// raise the flag and still recall dispatched packets.
func AdminCancel(state string, acceptedOrShipped int) (CancelDecision, error) {
	if state == "done" || state == "cancelled" {
		return CancelDecision{Name: "cancel.refuse_terminal"}, contract.Conflict("委托单已是终态")
	}
	if acceptedOrShipped > 0 {
		return CancelDecision{
			Name: "cancel.request", State: state, CancelRequested: true, Recall: true,
		}, nil
	}
	return CancelDecision{
		Name: "cancel.direct", State: "cancelled", Recall: true, ReleaseHeld: true,
	}, nil
}

// DispatchNo is dsp_ plus a public id with dashes removed.
func DispatchNo(publicID string) string {
	return "dsp_" + strings.ReplaceAll(publicID, "-", "")
}

// SellerKey is the wallet and factory idempotency key.
func SellerKey(dispatchID string) string { return "delegate:" + dispatchID }
