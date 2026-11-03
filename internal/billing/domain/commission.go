package domain

import (
	"bytes"
	"encoding/json"
	"math/big"
)

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
