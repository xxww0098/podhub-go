package domain

import (
	"math"
	"strings"
	"testing"
)

func TestRebatePolicyRanges(t *testing.T) {
	ok := `{"default_rebate_bps":0,"min_order_cents":0,"attribution_validity_days":0,"min_withdraw_cents":0}`
	if _, err := ParsePolicy([]byte(ok)); err != nil {
		t.Fatal(err)
	}
	top := `{"default_rebate_bps":10000,"min_order_cents":100000000,"attribution_validity_days":3650,"min_withdraw_cents":100000000}`
	if _, err := ParsePolicy([]byte(top)); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		body string
		msg  string
	}{
		{`{"default_rebate_bps":10001,"min_order_cents":0,"attribution_validity_days":0,"min_withdraw_cents":0}`, "返点比例需在 0-10000 bps 之间"},
		{`{"default_rebate_bps":-1,"min_order_cents":0,"attribution_validity_days":0,"min_withdraw_cents":0}`, "返点比例需在 0-10000 bps 之间"},
		{`{"default_rebate_bps":0,"min_order_cents":-1,"attribution_validity_days":0,"min_withdraw_cents":0}`, "合格首单门槛需在 0-100000000 分之间"},
		{`{"default_rebate_bps":0,"min_order_cents":100000001,"attribution_validity_days":0,"min_withdraw_cents":0}`, "合格首单门槛需在 0-100000000 分之间"},
		{`{"default_rebate_bps":0,"min_order_cents":0,"attribution_validity_days":0,"min_withdraw_cents":-1}`, "最低提现需在 0-100000000 分之间"},
		{`{"default_rebate_bps":0,"min_order_cents":0,"attribution_validity_days":0,"min_withdraw_cents":100000001}`, "最低提现需在 0-100000000 分之间"},
		{`{"default_rebate_bps":0,"min_order_cents":0,"attribution_validity_days":-1,"min_withdraw_cents":0}`, "归因有效期需在 0-3650 天之间"},
		{`{"default_rebate_bps":0,"min_order_cents":0,"attribution_validity_days":3651,"min_withdraw_cents":0}`, "归因有效期需在 0-3650 天之间"},
	}
	for _, tc := range cases {
		_, err := ParsePolicy([]byte(tc.body))
		if err == nil || err.(*APIError).Message != tc.msg || err.(*APIError).Code != "VALIDATION" || err.(*APIError).Status != 400 {
			t.Fatalf("%s got %v", tc.msg, err)
		}
	}
}

func TestInviteCodeRules(t *testing.T) {
	if _, err := NormalizeCustomInvite("SHORT12"); err == nil || err.(*APIError).Message != "自定义邀请码至少 8 位" {
		t.Fatal(err)
	}
	if _, err := NormalizeCustomInvite("OFFICIAL"); err == nil || err.(*APIError).Message != "该邀请码为保留字" {
		t.Fatal(err)
	}
	if _, err := NormalizeCustomInvite("official"); err == nil || err.(*APIError).Message != "该邀请码为保留字" {
		t.Fatal(err)
	}
	code, err := NormalizeCustomInvite("agentm2026")
	if err != nil || code != "AGENTM2026" {
		t.Fatal(code, err)
	}
	if _, err := NormalizeCustomInvite("AB"); err == nil || err.(*APIError).Message != "邀请码需为 4-32 位字母或数字" {
		t.Fatal(err)
	}
}

func TestCSVQuotingAndFormulas(t *testing.T) {
	line := func(cols ...string) string { return strings.Join(cols, ",") + "\n" }
	if got := line(CSVField("a@example.com"), CSVInt(1)); got != "a@example.com,1\n" {
		t.Fatal(got)
	}
	if got := line(CSVField("a,b"), CSVField("he said \"hi\"")); got != "\"a,b\",\"he said \"\"hi\"\"\"\n" {
		t.Fatal(got)
	}
	if got := line(CSVField("line\nbreak")); got != "\"line\nbreak\"\n" {
		t.Fatal(got)
	}
	formulas := []string{
		"=1+1", "+", "-", "@", "+1", "-1", "@SUM(1,1)",
		" =1", "\t", "\r", "\n", "\x00", "\u00A0=1", "\uFEFF", "\tWorkspace",
		`=HYPERLINK("http://x")`,
	}
	for _, in := range formulas {
		got := line(CSVField(in))
		want := "\"'" + strings.ReplaceAll(in, `"`, `""`) + "\"\n"
		if got != want {
			t.Fatalf("%q got %q want %q", in, got, want)
		}
	}
	got := line(CSVField("-42"), CSVInt(-42), CSVInt(0), CSVInt(math.MaxInt64), CSVInt(math.MinInt64))
	want := "\"'-42\",-42,0,9223372036854775807,-9223372036854775808\n"
	if got != want {
		t.Fatal(got)
	}
}

func TestAgentWithdrawalStatus(t *testing.T) {
	if _, ok, err := WithdrawalStatus(""); ok || err != nil {
		t.Fatal(ok, err)
	}
	if _, ok, err := WithdrawalStatus("  "); ok || err != nil {
		t.Fatal(ok, err)
	}
	status, ok, err := WithdrawalStatus(" pending ")
	if err != nil || !ok || status != "pending" {
		t.Fatal(status, ok, err)
	}
	for _, raw := range []string{"paid", "rejected"} {
		status, ok, err = WithdrawalStatus(raw)
		if err != nil || !ok || status != raw {
			t.Fatal(raw, err)
		}
	}
	if _, ok, err := WithdrawalStatus("later"); ok || err == nil || err.(*APIError).Message != "未知提现状态" || err.(*APIError).Code != "VALIDATION" {
		t.Fatal(ok, err)
	}
}

func TestAgentRejectReason(t *testing.T) {
	if _, err := ParseReject([]byte(`{"reason":"  "}`)); err == nil || err.(*APIError).Message != "拒绝原因必填" || err.(*APIError).Status != 400 {
		t.Fatal(err)
	}
	if _, err := ParseReject([]byte(`{}`)); err == nil || err.(*APIError).Message != "请求格式无效" {
		t.Fatal(err)
	}
	reason, err := ParseReject([]byte(`{"reason":" 收款账号与实名不符 "}`))
	if err != nil || reason != "收款账号与实名不符" {
		t.Fatal(reason, err)
	}
}
