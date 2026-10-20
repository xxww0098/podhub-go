package domain

import "testing"

func TestNormalizePriceThinkingCeiling(t *testing.T) {
	_, msg := NormalizePrice(PriceInput{BillingMode: "token", Output: 1_600_000, MaxRequest: 26214})
	if msg == "" {
		t.Fatal("26214 must refuse")
	}
	got, msg := NormalizePrice(PriceInput{BillingMode: "token", Output: 1_600_000, MaxRequest: 26216, Input: 1})
	if msg != "" || got.MaxRequest != 26216 || got.PerRequest != 0 || got.BillingMode != "token" {
		t.Fatalf("%+v %s", got, msg)
	}
	got, msg = NormalizePrice(PriceInput{BillingMode: "per_request", PerRequest: 1, Input: 9, MaxRequest: 3})
	if msg != "" || got.PerRequest != 1 || got.MaxRequest != 1 || got.Input != 0 {
		t.Fatalf("%+v %s", got, msg)
	}
	cases := []struct {
		in  PriceInput
		msg string
	}{
		{PriceInput{BillingMode: "token", MaxRequest: 0, Input: 1}, "单请求预占上限必须为正数"},
		{PriceInput{BillingMode: "token", MaxRequest: 1, Input: -1}, "价格不能为负"},
		{PriceInput{BillingMode: "token", MaxRequest: 1}, "Token 计价的四项单价不能全为 0"},
		{PriceInput{BillingMode: "per_request"}, "按次价格必须为正数"},
		{PriceInput{BillingMode: "other", MaxRequest: 1}, "计费模式无效"},
	}
	for _, tc := range cases {
		if _, msg := NormalizePrice(tc.in); msg != tc.msg {
			t.Fatalf("%q want %q", msg, tc.msg)
		}
	}
	if ValidPriceModel("o k") || ValidPriceModel("") || ValidPriceModel(strings128()) || !ValidPriceModel(" qwen3.7-flash ") {
		t.Fatal("model")
	}
}

func strings128() string {
	b := make([]byte, 129)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}
