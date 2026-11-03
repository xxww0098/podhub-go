package domain

import (
	"encoding/json"
	"os"
	"testing"
)

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
