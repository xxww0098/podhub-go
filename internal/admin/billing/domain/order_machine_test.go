package domain

import "testing"

func TestConfirmProductEdges(t *testing.T) {
	cases := []struct {
		name    string
		product string
		seats   int64
		days    int64
		want    ConfirmEdge
	}{
		{"wallet", "wallet_topup", 0, 0, EdgeWalletTopup},
		{"platform", "platform_goods", 0, 0, EdgePlatformGoods},
		{"seats", "member_seats", 2, 30, EdgeMemberSeats},
		{"seats zero", "member_seats", 0, 30, EdgeInvalid},
		{"seats no days", "member_seats", 2, 0, EdgeInvalid},
		{"unknown", "ocr", 1, 1, EdgeInvalid},
		{"closed is not a product", "closed", 1, 1, EdgeInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConfirmProduct(tc.product, tc.seats, tc.days); got != tc.want {
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

func TestSeatTier(t *testing.T) {
	for _, ok := range []string{"pro", "max", "ultra"} {
		if !SeatTier(ok) {
			t.Fatal(ok)
		}
	}
	for _, bad := range []string{"", "lite", "free", "PRO"} {
		if SeatTier(bad) {
			t.Fatal(bad)
		}
	}
}
