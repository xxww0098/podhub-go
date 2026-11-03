package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

func promotionJoinForConfirmation() Mutation {
	return promotionMutation("promotion_join", `{"kind":"promotion_join","action_id":7,"action_type":"ELASTIC_BOOSTING","items":[{"product_id":41,"offer_id":"41","action_price":"1.00","currency_code":"RUB","stock":0}]}`)
}

func promotionConfirmationFixture() promotionReadFixture {
	return promotionReadFixture{
		actions: []contract.PromotionAction{{ActionID: 7, ActionType: "ELASTIC_BOOSTING", DateEnd: "2027-01-01T00:00:00Z"}},
		products: func(id int64, joined bool, cursor string) (contract.PromotionPage, *contract.Fail) {
			if joined {
				return contract.PromotionPage{Offers: []contract.PromotionOffer{}, Total: 0}, nil
			}
			return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, ActionPrice: "1.00", MaxActionPrice: "1.00", CurrencyCode: "RUB"}}, Total: 1, NextCursor: "terminal"}, nil
		},
		prices: func(ids []int64) ([]contract.PromotionPrice, *contract.Fail) {
			return []contract.PromotionPrice{{ProductID: 41, OfferID: "41", Price: "1.0000", CurrencyCode: "RUB"}}, nil
		},
	}
}

func TestPromotionPreflightUsesCurrentActivityAndPriceFacts(t *testing.T) {
	for _, mode := range []string{"valid", "frozen", "type changed", "expired", "ineligible", "over cap", "wrong currency", "quarantined", "wrong offer", "mixed card currency"} {
		t.Run(mode, func(t *testing.T) {
			m, read := promotionJoinForConfirmation(), promotionConfirmationFixture()
			switch mode {
			case "frozen":
				read.actions[0].FreezeDate = "2026-10-31T00:00:00Z"
			case "type changed":
				read.actions[0].ActionType = "PROMOCODE"
			case "expired":
				read.actions[0].DateEnd = "2020-01-01T00:00:00Z"
			case "ineligible":
				read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
					return contract.PromotionPage{Offers: []contract.PromotionOffer{}, Total: 0}, nil
				}
			case "over cap":
				m.Raw = json.RawMessage(strings.Replace(string(m.Raw), `"1.00"`, `"1.01"`, 1))
			case "wrong currency":
				m.Raw = json.RawMessage(strings.ReplaceAll(string(m.Raw), "RUB", "CNY"))
			case "quarantined":
				old := read.products
				read.products = func(id int64, joined bool, cursor string) (contract.PromotionPage, *contract.Fail) {
					page, f := old(id, joined, cursor)
					for i := range page.Offers {
						yes := true
						page.Offers[i].PriceQuarantined = &yes
					}
					return page, f
				}
			case "wrong offer":
				m.Raw = json.RawMessage(strings.Replace(string(m.Raw), `"offer_id":"41"`, `"offer_id":"wrong"`, 1))
			case "mixed card currency":
				read.prices = func([]int64) ([]contract.PromotionPrice, *contract.Fail) {
					return []contract.PromotionPrice{{ProductID: 41, OfferID: "41", Price: "1", CurrencyCode: "CNY"}}, nil
				}
			}
			fail := PreflightPromotion(m, read, time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC))
			if mode == "valid" {
				if fail != nil {
					t.Fatal(fail)
				}
				return
			}
			if fail == nil || fail.Code != contract.CodeValidation {
				t.Fatalf("mode=%s fail=%v", mode, fail)
			}
		})
	}
}

func TestPromotionReadbackUsesOnlyAcceptedItemsAndNeverSendsWrites(t *testing.T) {
	m := promotionJoinForConfirmation()
	m.Raw = json.RawMessage(strings.Replace(string(m.Raw), `]}`, `,{"product_id":42,"offer_id":"42","action_price":"1.00","currency_code":"RUB","stock":0}]}`, 1))
	read := promotionConfirmationFixture()
	read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
		return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, ActionPrice: "1", CurrencyCode: "RUB"}}, Total: 1, NextCursor: "last"}, nil
	}
	read.prices = func(ids []int64) ([]contract.PromotionPrice, *contract.Fail) {
		if len(ids) != 1 || ids[0] != 41 {
			t.Fatal("rejected item entered readback", ids)
		}
		return []contract.PromotionPrice{{ProductID: 41, OfferID: "41", Price: "1", CurrencyCode: "RUB"}}, nil
	}
	receipt := viewOf(m.OperationID, []itemResult{{Identity: "41", Succeeded: true}, {Identity: "42", Succeeded: false, Message: "rejected"}})
	if fail := ConfirmPromotion(m, receipt, read); fail != nil {
		t.Fatal(fail)
	}
	read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
		t.Fatal("rejected batch was read back")
		return contract.PromotionPage{}, nil
	}
	if fail := ConfirmPromotion(m, viewOf(m.OperationID, []itemResult{{Identity: "41"}, {Identity: "42"}}), read); fail != nil {
		t.Fatal(fail)
	}
}

func TestPromotionObserveRequiresCompleteMembershipAndExactCardPrice(t *testing.T) {
	for _, mode := range []string{"applied", "card price mismatch", "card currency mismatch", "member missing", "membership incomplete"} {
		t.Run(mode, func(t *testing.T) {
			m, read := promotionJoinForConfirmation(), promotionConfirmationFixture()
			read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
				if mode == "member missing" {
					return contract.PromotionPage{Offers: []contract.PromotionOffer{}, Total: 0}, nil
				}
				total, id := int64(1), int64(41)
				if mode == "membership incomplete" {
					total, id = 2, 42
				}
				return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: id, ActionPrice: "1", CurrencyCode: "RUB"}}, Total: total}, nil
			}
			read.prices = func([]int64) ([]contract.PromotionPrice, *contract.Fail) {
				row := contract.PromotionPrice{ProductID: 41, OfferID: "41", Price: "1.0000", CurrencyCode: "RUB"}
				if mode == "card price mismatch" {
					row.Price = "0.99"
				}
				if mode == "card currency mismatch" {
					row.CurrencyCode = "CNY"
				}
				return []contract.PromotionPrice{row}, nil
			}
			state, note := Observe("product_mutation", m.Raw, func(string, string, []byte) Page {
				t.Fatal("promotion observation used generic write/read path")
				return Page{}
			}, read)
			want := "contradicted"
			if mode == "applied" {
				want = "applied"
			}
			if mode == "membership incomplete" {
				want = "indeterminate"
			}
			if state != want {
				t.Fatalf("state=%s want=%s note=%s", state, want, note)
			}
			fail := ConfirmPromotion(m, viewOf(m.OperationID, []itemResult{{Identity: "41", Succeeded: true}}), read)
			if (fail == nil) != (mode == "applied") || fail != nil && fail.Code != contract.CodeSellerUnknown {
				t.Fatalf("state=%s confirmation=%v", state, fail)
			}
		})
	}
}

func TestPromotionLeaveObservationRequiresCompleteAbsenceAndExitPrice(t *testing.T) {
	m := promotionMutation("promotion_leave", `{"kind":"promotion_leave","action_id":7,"action_type":"ELASTIC_BOOSTING","product_ids":[41],"exit_prices":[{"product_id":41,"exit_price":"2.00","currency_code":"RUB"}]}`)
	read := promotionConfirmationFixture()
	read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
		return contract.PromotionPage{Offers: []contract.PromotionOffer{}, Total: 0}, nil
	}
	read.prices = func([]int64) ([]contract.PromotionPrice, *contract.Fail) {
		return []contract.PromotionPrice{{ProductID: 41, OfferID: "41", Price: "2", CurrencyCode: "RUB"}}, nil
	}
	if state, note := Observe("product_mutation", m.Raw, nil, read); state != "applied" {
		t.Fatalf("%s %s", state, note)
	}
	read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
		return contract.PromotionPage{Offers: []contract.PromotionOffer{}, Total: 10}, nil
	}
	if state, _ := Observe("product_mutation", m.Raw, nil, read); state != "indeterminate" {
		t.Fatal("incomplete membership proved absence")
	}
}

func TestPromotionPreflightEnforcesExitCapAndPromocodeMinimumStock(t *testing.T) {
	read := promotionConfirmationFixture()
	read.products = func(_ int64, joined bool, _ string) (contract.PromotionPage, *contract.Fail) {
		if !joined {
			return contract.PromotionPage{Total: 0}, nil
		}
		return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, ActionPrice: "1", MaxActionPrice: "1", CurrencyCode: "RUB"}}, Total: 1}, nil
	}
	for _, price := range []string{"1.00", "2.00"} {
		m := promotionMutation("promotion_leave", `{"action_id":7,"action_type":"ELASTIC_BOOSTING","product_ids":[41],"exit_prices":[{"product_id":41,"exit_price":"`+price+`","currency_code":"RUB"}]}`)
		fail := PreflightPromotion(m, read, time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC))
		if (fail == nil) != (price == "2.00") {
			t.Fatalf("exit=%s fail=%v", price, fail)
		}
	}
	read.actions[0].ActionType = "PROMOCODE"
	for _, minimum := range []*int64{nil, new(int64), func() *int64 { n := int64(4); return &n }()} {
		read.products = func(_ int64, joined bool, _ string) (contract.PromotionPage, *contract.Fail) {
			if joined {
				return contract.PromotionPage{Total: 0}, nil
			}
			return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, ActionPrice: "1", MaxActionPrice: "1", CurrencyCode: "RUB", MinStock: minimum}}, Total: 1}, nil
		}
		m := promotionMutation("promotion_join", `{"action_id":7,"action_type":"PROMOCODE","items":[{"product_id":41,"offer_id":"41","action_price":"1","currency_code":"RUB","stock":3}]}`)
		fail := PreflightPromotion(m, read, time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC))
		if (fail == nil) != (minimum != nil && *minimum <= 3) {
			t.Fatalf("minimum=%v fail=%v", minimum, fail)
		}
	}
}

func TestPromotionExistingTargetNeedsNoCandidateScanOrUnrelatedTotals(t *testing.T) {
	m, read := promotionJoinForConfirmation(), promotionConfirmationFixture()
	read.products = func(_ int64, joined bool, _ string) (contract.PromotionPage, *contract.Fail) {
		if !joined {
			t.Fatal("existing target scanned stale candidates")
		}
		return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, ActionPrice: "1", MaxActionPrice: "1", CurrencyCode: "RUB"}}, Total: 108}, nil
	}
	if fail := PreflightPromotion(m, read, time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)); fail != nil {
		t.Fatal(fail)
	}
	if state, note := Observe("product_mutation", m.Raw, nil, read); state != "applied" {
		t.Fatalf("%s %s", state, note)
	}
}

func TestPromotionCandidateTargetCanBeProvenWithoutClaimingStaleTotalComplete(t *testing.T) {
	m, read := promotionJoinForConfirmation(), promotionConfirmationFixture()
	read.actions[0].PotentialProductsTotal = 55
	candidateCalls := 0
	read.products = func(_ int64, joined bool, cursor string) (contract.PromotionPage, *contract.Fail) {
		if joined {
			return contract.PromotionPage{Total: 0}, nil
		}
		candidateCalls++
		rows := []contract.PromotionOffer{}
		if cursor == "" {
			for id := int64(1); id <= 54; id++ {
				rows = append(rows, contract.PromotionOffer{ProductID: id, ActionPrice: "1", MaxActionPrice: "1", CurrencyCode: "RUB"})
			}
		}
		return contract.PromotionPage{Offers: rows, Total: 55, NextCursor: "terminal"}, nil
	}
	if fail := PreflightPromotion(m, read, time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)); fail != nil || candidateCalls != 1 {
		t.Fatalf("target preflight=%v reads=%d", fail, candidateCalls)
	}
	id, joined := int64(7), false
	raw, fail := Promotions(PromotionsRequest{ActionID: &id, Participating: &joined}, read)
	if fail != nil || !strings.Contains(string(raw), `"total":55`) || !strings.Contains(string(raw), `"next_cursor":"terminal"`) {
		t.Fatalf("page concealed stale total: %s %v", raw, fail)
	}
	candidateCalls = 0
	m.Raw = json.RawMessage(strings.ReplaceAll(string(m.Raw), "41", "99"))
	if fail := PreflightPromotion(m, read, time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)); fail == nil || fail.Status != 502 || candidateCalls != 2 {
		t.Fatalf("missing target inferred absent from incomplete candidates: fail=%v reads=%d", fail, candidateCalls)
	}
}
