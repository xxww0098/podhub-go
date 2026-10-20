package domain

import (
	"bytes"
	"math"
	"strings"
	"testing"
)

func TestNormalizeInviteCode(t *testing.T) {
	cases := []struct {
		in  string
		out string
		ok  bool
	}{
		{" abcd ", "ABCD", true},
		{"nope9999", "NOPE9999", true},
		{"Ab12", "AB12", true},
		{"abc", "", false},
		{strings.Repeat("a", 33), "", false},
		{"ab-cd", "", false},
		{"  ", "", false},
		{"ab c", "", false},
		{"éabc", "", false},
		{strings.Repeat("Z", 32), strings.Repeat("Z", 32), true},
	}
	for _, tc := range cases {
		got, ok := NormalizeInviteCode(tc.in)
		if ok != tc.ok || got != tc.out {
			t.Fatalf("%q -> %q %v, want %q %v", tc.in, got, ok, tc.out, tc.ok)
		}
	}
}

func TestMaskEmail(t *testing.T) {
	cases := map[string]string{
		"alice@example.com": "a***@example.com",
		"i@example.invalid": "i***@example.invalid",
		"a@b":               "a***@b",
		"@x":                "***@x",
		"noat":              "***",
		"":                  "***",
	}
	for in, want := range cases {
		if got := MaskEmail(in); got != want {
			t.Fatalf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestNormalizePayoutMessages(t *testing.T) {
	s := func(v string) *string { return &v }
	cases := []struct {
		name    string
		ch, ac  *string
		rn      *string
		msg     string
		clear   bool
		channel string
	}{
		{"clear", nil, nil, nil, "", true, ""},
		{"missing account", s("alipay"), nil, s("李四"), "收款方式、账号、姓名须同时填写或同时留空", false, ""},
		{"paypal", s("paypal"), s("a@x.invalid"), s("Alice"), "收款渠道仅支持支付宝或微信", false, ""},
		{"short", s("alipay"), s("x"), s("Alice"), "收款账号需为 2-128 字符", false, ""},
		{"short name", s("alipay"), s("ab"), s("李"), "收款姓名需为 2-64 字符", false, ""},
		{"empty strings", s(""), s(""), s(""), "收款渠道仅支持支付宝或微信", false, ""},
		{"fold", s("  ALIPAY "), s("  agent@x.invalid "), s(" 代理人 "), "", false, "alipay"},
		{"wechat", s("wechat"), s("wx-agent-1"), s("代理人"), "", false, "wechat"},
	}
	for _, tc := range cases {
		p, clear, msg := NormalizePayout(tc.ch, tc.ac, tc.rn)
		if msg != tc.msg || clear != tc.clear {
			t.Fatalf("%s: msg %q clear %v", tc.name, msg, clear)
		}
		if tc.msg == "" && !clear && p.Channel != tc.channel {
			t.Fatalf("%s channel %s", tc.name, p.Channel)
		}
		if tc.name == "fold" && (p.Account != "agent@x.invalid" || p.RealName != "代理人") {
			t.Fatalf("stored %+v", p)
		}
	}
	long := strings.Repeat("a", 129)
	if _, _, msg := NormalizePayout(s("alipay"), &long, s("李四")); msg != "收款账号需为 2-128 字符" {
		t.Fatal(msg)
	}
	name := strings.Repeat("名", 65)
	if _, _, msg := NormalizePayout(s("alipay"), s("ab"), &name); msg != "收款姓名需为 2-64 字符" {
		t.Fatal(msg)
	}
}

func TestMoneyAndWindows(t *testing.T) {
	if BodyLimitBytes != 2*1024*1024 || LedgerWindow != 200 || CommissionWindow != 200 || WithdrawalWindow != 200 {
		t.Fatal("limits")
	}
	if ReviewThreshold != 20 || AuthGateKey != 0x6f7a6f6e5f617574 || MicrofenPerFen != 1_000_000 {
		t.Fatal("constants")
	}
	got, ok := Microfen(10000)
	if !ok || got != 10000*MicrofenPerFen {
		t.Fatal(got, ok)
	}
	if _, ok := Microfen(math.MaxInt64); ok {
		t.Fatal("overflow")
	}
	if SaturatingSub(5, 3) != 2 || SaturatingSub(1, 2) != -1 || SaturatingSub(math.MinInt64, 1) != math.MinInt64 {
		t.Fatal("saturating")
	}
	if AgentLedgerVisible("commission") == false || AgentLedgerVisible("transfer_out") == false || AgentLedgerVisible("withdrawal_hold") {
		t.Fatal("filter")
	}
}

func TestWithdrawalPublicIDAlphabet(t *testing.T) {
	if len(WithdrawalAlphabet) != 32 {
		t.Fatal(len(WithdrawalAlphabet))
	}
	id, err := WithdrawalPublicID(bytes.NewReader([]byte{0, 31, 32, 1, 2, 3, 4, 5, 6, 7, 8, 9}))
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 15 || id[:3] != "wd_" {
		t.Fatal(id)
	}
	for _, c := range id[3:] {
		if !strings.ContainsRune(WithdrawalAlphabet, c) {
			t.Fatal(id)
		}
	}
	if _, err := WithdrawalPublicID(bytes.NewReader([]byte{1, 2})); err == nil {
		t.Fatal("short")
	}
}
