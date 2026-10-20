package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"time"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

// SeatCreditLine is the confirm snapshot. Keys are snake_case. Unknown keys
// are ignored. The consumed amount is whatever creation stored; confirm does
// not recompute it.
type SeatCreditLine struct {
	LotID              int64     `json:"lot_id"`
	Tier               string    `json:"tier"`
	Seats              int64     `json:"seats"`
	StartsAt           time.Time `json:"starts_at"`
	ExpiresAt          time.Time `json:"expires_at"`
	TotalDays          int64     `json:"total_days"`
	UsedDays           int64     `json:"used_days"`
	RemainingDays      int64     `json:"remaining_days"`
	LotValueCents      int64     `json:"lot_value_cents"`
	ConsumedValueCents int64     `json:"consumed_value_cents"`
}

// ParseSeatCreditLines decodes credit_lots. The error text always starts with
// 抵扣快照无法解析：. The serde suffix after that prefix is not pinned.
func ParseSeatCreditLines(raw []byte) ([]SeatCreditLine, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var items []json.RawMessage
	if err := dec.Decode(&items); err != nil || dec.More() {
		return nil, fmt.Errorf("抵扣快照无法解析：%v", err)
	}
	if items == nil {
		return []SeatCreditLine{}, nil
	}
	out := make([]SeatCreditLine, 0, len(items))
	for _, item := range items {
		line, err := parseCreditLine(item)
		if err != nil {
			return nil, fmt.Errorf("抵扣快照无法解析：%v", err)
		}
		out = append(out, line)
	}
	return out, nil
}

func parseCreditLine(raw json.RawMessage) (SeatCreditLine, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return SeatCreditLine{}, fmt.Errorf("invalid type")
	}
	var line SeatCreditLine
	fields := []struct {
		key string
		dst any
	}{
		{"lot_id", &line.LotID},
		{"tier", &line.Tier},
		{"seats", &line.Seats},
		{"starts_at", &line.StartsAt},
		{"expires_at", &line.ExpiresAt},
		{"total_days", &line.TotalDays},
		{"used_days", &line.UsedDays},
		{"remaining_days", &line.RemainingDays},
		{"lot_value_cents", &line.LotValueCents},
		{"consumed_value_cents", &line.ConsumedValueCents},
	}
	for _, field := range fields {
		value, ok := obj[field.key]
		if !ok {
			return SeatCreditLine{}, fmt.Errorf("missing field `%s`", field.key)
		}
		if err := json.Unmarshal(value, field.dst); err != nil {
			return SeatCreditLine{}, err
		}
	}
	return line, nil
}

// SeatApplyGate is the second check inside apply_member_seats. Confirm's
// product switch already rejects seats below 1 as 订单商品无效.
func SeatApplyGate(plan string, seats int64) *corecontract.Fault {
	if !SeatTier(plan) {
		return corecontract.Validation("VALIDATION", "成员名额档位无效")
	}
	if seats < 1 {
		return corecontract.Validation("VALIDATION", "成员名额数量无效")
	}
	return nil
}

// CommissionCents is floor(amount * bps / 10000). A negative amount or a bps
// outside 0..=10000 is 0.
func CommissionCents(amount, bps int64) int64 {
	if amount < 0 || bps < 0 || bps > 10000 {
		return 0
	}
	product := new(big.Int).Mul(big.NewInt(amount), big.NewInt(bps))
	return product.Div(product, big.NewInt(10000)).Int64()
}

// CommissionDecision is the skip-or-credit result after an agent row is known.
type CommissionDecision struct {
	Credited bool
	BPS      int64
	Amount   int64
	Note     string
}

// DecideCommission applies the skip order from settle_first_order_commission.
// hasAgent false uses defaultBPS and skips with 代理不存在.
func DecideCommission(amount, defaultBPS int64, hasAgent bool, status string, attribution *int64, expired bool) CommissionDecision {
	bps := defaultBPS
	if hasAgent && attribution != nil {
		bps = *attribution
	}
	if !hasAgent {
		return CommissionDecision{BPS: bps, Note: "代理不存在"}
	}
	if status != "active" {
		return CommissionDecision{BPS: bps, Note: "代理已停用"}
	}
	if expired {
		return CommissionDecision{BPS: bps, Note: "归因已过期"}
	}
	if bps == 0 {
		return CommissionDecision{BPS: bps, Note: "返点比例为 0"}
	}
	cents := CommissionCents(amount, bps)
	if cents == 0 {
		return CommissionDecision{BPS: bps, Note: "佣金不足 1 分"}
	}
	return CommissionDecision{Credited: true, BPS: bps, Amount: cents, Note: ""}
}

// MaskInviteeEmail is mask_email. The first Unicode scalar of the local part
// is kept. No '@' becomes ***.
func MaskInviteeEmail(email string) string {
	at := -1
	for i := 0; i < len(email); i++ {
		if email[i] == '@' {
			at = i
			break
		}
	}
	if at < 0 {
		return "***"
	}
	head := ""
	for _, r := range email[:at] {
		head = string(r)
		break
	}
	return head + "***@" + email[at+1:]
}

// CommissionNote is the credited commission note. The middle dot is U+00B7.
func CommissionNote(publicID string) string {
	return "代理佣金 · 订单 " + publicID
}

// CommissionPayload is the notification JSON. Key order is the struct order.
// HTML is not escaped.
func CommissionPayload(amountCents int64, publicID, email string) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	err := enc.Encode(struct {
		AmountCents          int64  `json:"amountCents"`
		PaymentOrderPublicID string `json:"paymentOrderPublicId"`
		InviteeEmail         string `json:"inviteeEmail"`
	}{amountCents, publicID, MaskInviteeEmail(email)})
	if err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
