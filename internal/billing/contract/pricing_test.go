package contract

import "testing"

func TestNormalizeMatchesPublishRules(t *testing.T) {
	_, message, ok := Normalize("m", PublishRequest{BillingMode: ModeToken, MaxRequest: 26_214, Input: 1, Output: 1_600_000})
	if ok || message != "单请求预占上限不足以支付最深思考预算（16384 个输出 token），请提高预占上限" {
		t.Fatalf("%v %s", ok, message)
	}
	got, _, ok := Normalize("m", PublishRequest{BillingMode: ModeToken, MaxRequest: 26_216, Input: 1, Output: 1_600_000})
	if !ok || got.PerRequest != 0 || got.Model != "m" {
		t.Fatalf("%+v %v", got, ok)
	}
	got, _, ok = Normalize("m", PublishRequest{BillingMode: ModePerRequest, PerRequest: 9, Input: 5})
	if !ok || got.MaxRequest != 9 || got.Input != 0 || got.PerRequest != 9 {
		t.Fatalf("%+v", got)
	}
}
