package domain

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSeatCreditLineHandFixture(t *testing.T) {
	raw := []byte(`[{
		"lot_id": 42,
		"tier": "starter",
		"seats": 1,
		"starts_at": "2026-09-17T00:00:00Z",
		"expires_at": "2026-10-17T00:00:00Z",
		"total_days": 30,
		"used_days": 10,
		"remaining_days": 20,
		"lot_value_cents": 3000,
		"consumed_value_cents": 2000,
		"ignored": true
	}]`)
	lines, err := ParseSeatCreditLines(raw)
	if err != nil || len(lines) != 1 {
		t.Fatal(err, len(lines))
	}
	line := lines[0]
	if line.LotID != 42 || line.Tier != "starter" || line.Seats != 1 || line.TotalDays != 30 || line.UsedDays != 10 || line.RemainingDays != 20 || line.LotValueCents != 3000 || line.ConsumedValueCents != 2000 {
		t.Fatalf("%+v", line)
	}
	if !line.StartsAt.Equal(time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC)) || !line.ExpiresAt.Equal(time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)) {
		t.Fatal(line.StartsAt, line.ExpiresAt)
	}
	if _, err := ParseSeatCreditLines([]byte(`[]`)); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSeatCreditLines([]byte(`{}`)); err == nil || !strings.HasPrefix(err.Error(), "抵扣快照无法解析：") {
		t.Fatal(err)
	}
	if _, err := ParseSeatCreditLines([]byte(`[{}]`)); err == nil || !strings.Contains(err.Error(), "missing field `lot_id`") {
		t.Fatal(err)
	}
	if fault := SeatApplyGate("lite", 1); fault == nil || fault.Message != "成员名额档位无效" {
		t.Fatal(fault)
	}
	if fault := SeatApplyGate("pro", 0); fault == nil || fault.Message != "成员名额数量无效" {
		t.Fatal(fault)
	}
	if SeatApplyGate("pro", 1) != nil {
		t.Fatal("pro")
	}
}

func TestCommissionDecisionAndPayload(t *testing.T) {
	if got := CommissionCents(3000, 20); got != 6 {
		t.Fatal(got)
	}
	if got := CommissionCents(10000, 100); got != 100 {
		t.Fatal(got)
	}
	if CommissionCents(-1, 100) != 0 || CommissionCents(100, 10001) != 0 || CommissionCents(100, -1) != 0 {
		t.Fatal("bounds")
	}
	bps := int64(100)
	got := DecideCommission(10000, 1000, true, "active", &bps, false)
	if !got.Credited || got.Amount != 100 || got.BPS != 100 {
		t.Fatalf("%+v", got)
	}
	missing := DecideCommission(10000, 1000, false, "", nil, false)
	if missing.Credited || missing.Note != "代理不存在" || missing.BPS != 1000 || missing.Amount != 0 {
		t.Fatalf("%+v", missing)
	}
	disabled := DecideCommission(10000, 1000, true, "disabled", &bps, false)
	if disabled.Note != "代理已停用" || disabled.Credited {
		t.Fatal(disabled)
	}
	expired := DecideCommission(10000, 1000, true, "active", &bps, true)
	if expired.Note != "归因已过期" {
		t.Fatal(expired)
	}
	zero := int64(0)
	none := DecideCommission(10000, 1000, true, "active", &zero, false)
	if none.Note != "返点比例为 0" || none.BPS != 0 {
		t.Fatal(none)
	}
	dust := DecideCommission(50, 1000, true, "active", &bps, false)
	if dust.Note != "佣金不足 1 分" || dust.Amount != 0 {
		t.Fatalf("%+v", dust)
	}
	if MaskInviteeEmail("a@example.com") != "a***@example.com" || MaskInviteeEmail("no-at") != "***" {
		t.Fatal(MaskInviteeEmail("a@example.com"))
	}
	payload, err := CommissionPayload(100, "pay_example", "a@example.com")
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"amountCents":100,"paymentOrderPublicId":"pay_example","inviteeEmail":"a***@example.com"}`
	if string(payload) != want {
		t.Fatalf("%s", payload)
	}
	if CommissionNote("pay_example") != "代理佣金 · 订单 pay_example" {
		t.Fatal(CommissionNote("pay_example"))
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(payload, &doc); err != nil || len(doc) != 3 {
		t.Fatal(err)
	}
	_ = os.Stderr
}
