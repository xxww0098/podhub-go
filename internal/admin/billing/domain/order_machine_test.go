package domain

import "testing"

func TestConfirmProductEdges(t *testing.T) {
	cases := []struct {
		product string
		want    ConfirmEdge
	}{
		{"subscription", EdgeSubscription},
		{"wallet_topup", EdgeWalletTopup},
		{"platform_goods", EdgePlatformGoods},
		{"member_seats", EdgeInvalid},
		{"unknown", EdgeInvalid},
		{"closed", EdgeInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.product, func(t *testing.T) {
			if got := ConfirmProduct(tc.product); got != tc.want {
				t.Fatalf("got %s", got)
			}
		})
	}
}

func TestCancelPendingEdges(t *testing.T) {
	cases := []struct {
		name     string
		found    bool
		status   string
		provider string
		want     CancelEdge
	}{
		{"manual pending", true, "pending", "manual", CancelApply},
		{"paid illegal", true, "paid", "manual", CancelHandled},
		{"canceled illegal", true, "canceled", "manual", CancelHandled},
		{"alipay pending illegal", true, "pending", "alipay", CancelUpstream},
		{"wechat", true, "pending", "wechat", CancelUpstream},
		{"stripe", true, "pending", "stripe", CancelUpstream},
		{"easypay", true, "pending", "easypay", CancelUpstream},
		{"missing", false, "pending", "manual", CancelMissing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CancelPending(tc.found, tc.status, tc.provider); got != tc.want {
				t.Fatalf("got %s", got)
			}
		})
	}
}
