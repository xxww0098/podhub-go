package billingrepo

import "testing"

func TestDecidePaymentReplay(t *testing.T) {
	cases := []struct {
		name    string
		status  string
		product string
		topup   int64
		hit     bool
		ledger  string
		want    string
	}{
		{"paid topup", "pending", "wallet_topup", 10, true, "paid", ReplayTopup},
		{"succeeded topup", "pending", "wallet_topup", 10, true, "succeeded", ReplayTopup},
		{"member seats stay", "pending", "member_seats", 0, true, "paid", ReplayLeave},
		{"zero topup stays", "pending", "wallet_topup", 0, true, "paid", ReplayLeave},
		{"already paid", "paid", "wallet_topup", 10, true, "paid", ReplaySkip},
		{"canceled", "canceled", "wallet_topup", 10, true, "succeeded", ReplaySkip},
		{"no ledger", "pending", "wallet_topup", 10, false, "paid", ReplaySkip},
		{"ledger failed", "pending", "wallet_topup", 10, true, "failed", ReplaySkip},
		{"platform goods", "pending", "platform_goods", 0, true, "succeeded", ReplayLeave},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DecidePaymentReplay(tc.status, tc.product, tc.topup, tc.hit, tc.ledger)
			if got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}
