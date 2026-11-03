package domain

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

type promotionReadFixture struct {
	actions  []contract.PromotionAction
	products func(int64, bool, string) (contract.PromotionPage, *contract.Fail)
	details  func([]int64) ([]contract.PromotionIdentity, *contract.Fail)
	prices   func([]int64) ([]contract.PromotionPrice, *contract.Fail)
}

func (r promotionReadFixture) Actions() ([]contract.PromotionAction, *contract.Fail) {
	return r.actions, nil
}
func (r promotionReadFixture) Products(id int64, joined bool, cursor string) (contract.PromotionPage, *contract.Fail) {
	return r.products(id, joined, cursor)
}
func (r promotionReadFixture) Details(ids []int64) ([]contract.PromotionIdentity, *contract.Fail) {
	if r.details != nil {
		return r.details(ids)
	}
	out := make([]contract.PromotionIdentity, 0, len(ids))
	for _, id := range ids {
		out = append(out, contract.PromotionIdentity{ProductID: id, OfferID: fmt.Sprint(id), Name: "Seller product", SKU: "18446744073709551615"})
	}
	return out, nil
}
func (r promotionReadFixture) Prices(ids []int64) ([]contract.PromotionPrice, *contract.Fail) {
	return r.prices(ids)
}

func TestPromotionCatalogDoesNotScanProducts(t *testing.T) {
	read := promotionReadFixture{actions: []contract.PromotionAction{{ActionID: 12, Title: "Empty campaign"}, {ActionID: 13, Title: "Joined campaign", PotentialProductsTotal: 4, ParticipatingProductsTotal: 2}}}
	read.products = func(int64, bool, string) (contract.PromotionPage, *contract.Fail) {
		t.Fatal("catalog scanned products")
		return contract.PromotionPage{}, nil
	}
	raw, fail := Promotions(PromotionsRequest{}, read)
	var got struct {
		Data struct {
			Actions []contract.PromotionAction `json:"actions"`
			Offers  []contract.PromotionOffer  `json:"offers"`
		} `json:"data"`
	}
	if fail != nil || json.Unmarshal(raw, &got) != nil || len(got.Data.Actions) != 2 || len(got.Data.Offers) != 0 || got.Data.Actions[0].ActionID != 12 || got.Data.Actions[1].ParticipatingProductsTotal != 2 {
		t.Fatalf("catalog=%s fail=%v", raw, fail)
	}
}

func TestPromotionPagePreservesShortCursorAndEnrichesOnePage(t *testing.T) {
	id, joined := int64(12), false
	calls, details := 0, 0
	read := promotionReadFixture{actions: []contract.PromotionAction{{ActionID: id, Title: "Campaign"}}}
	read.products = func(action int64, participating bool, cursor string) (contract.PromotionPage, *contract.Fail) {
		calls++
		if action != id || participating || cursor != "first" {
			t.Fatal("pagination request lost")
		}
		return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, Price: "99.1234", PriceCurrencyCode: "CNY", ActionPrice: "88.01", MaxActionPrice: "50.00", CurrencyCode: "RUB"}}, Total: 150, NextCursor: "second"}, nil
	}
	read.details = func(ids []int64) ([]contract.PromotionIdentity, *contract.Fail) {
		details++
		if len(ids) != 1 || ids[0] != 41 {
			t.Fatal(ids)
		}
		return []contract.PromotionIdentity{{ProductID: 41, OfferID: "real-offer", Name: "Real product", SKU: "18446744073709551615"}}, nil
	}
	raw, fail := Promotions(PromotionsRequest{ActionID: &id, Participating: &joined, Cursor: "first"}, read)
	if fail != nil || calls != 1 || details != 1 || !strings.Contains(string(raw), `"next_cursor":"second"`) || !strings.Contains(string(raw), `"sku":"18446744073709551615"`) || !strings.Contains(string(raw), `"max_action_price":"50.00"`) || !strings.Contains(string(raw), `"stock":null`) {
		t.Fatalf("page=%s fail=%v", raw, fail)
	}
}

func TestPromotionSelectionRequiresCompleteNonRepeatingPages(t *testing.T) {
	for _, mode := range []string{"short cursor", "final nonempty cursor", "missing page", "loop", "duplicate", "limit"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			read := promotionReadFixture{actions: []contract.PromotionAction{{ActionID: 12, Title: "Campaign", PotentialProductsTotal: 2}}}
			read.products = func(_ int64, joined bool, cursor string) (contract.PromotionPage, *contract.Fail) {
				if joined {
					return contract.PromotionPage{Offers: []contract.PromotionOffer{}, Total: 0}, nil
				}
				calls++
				page := contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: int64(calls)}}, Total: 2}
				switch mode {
				case "short cursor":
					if cursor == "" {
						page.NextCursor = "second"
					}
				case "final nonempty cursor":
					page.NextCursor = fmt.Sprint(calls)
				case "loop":
					page.Total = 3
					page.NextCursor = "loop"
				case "duplicate":
					page.Offers[0].ProductID = 1
					if calls == 1 {
						page.NextCursor = "second"
					}
				case "limit":
					page.Total = 30
					page.NextCursor = fmt.Sprint(calls)
				}
				return page, nil
			}
			wanted := []int64{99}
			if mode == "short cursor" || mode == "final nonempty cursor" {
				wanted = []int64{1, 2}
			}
			raw, fail := Promotions(PromotionsRequest{ProductIDs: wanted}, read)
			if mode == "short cursor" || mode == "final nonempty cursor" {
				if fail != nil || calls != 2 || len(raw) == 0 {
					t.Fatalf("page=%s fail=%v calls=%d", raw, fail, calls)
				}
				return
			}
			if fail == nil || fail.Status != 502 || len(raw) != 0 {
				t.Fatalf("incomplete selection=%s fail=%v", raw, fail)
			}
		})
	}
}

func TestPromotionRequestCombinations(t *testing.T) {
	for _, raw := range []string{
		`{"store_id":"store","product_ids":[]}`, `{"store_id":"store","product_ids":[41]}`, `{"store_id":"store","product_ids":[],"action_id":12,"participating":false,"cursor":"token"}`,
	} {
		req, err := DecodePromotions([]byte(raw))
		if err != nil || ValidatePromotions(req) != nil {
			t.Fatalf("valid request rejected: %s", raw)
		}
	}
	for _, raw := range []string{
		`{"store_id":"store","product_ids":null}`, `{"store_id":"store"}`, `{"store_id":"store","product_ids":[],"action_id":12}`, `{"store_id":"store","product_ids":[41],"action_id":12,"participating":false}`, `{"store_id":"store","product_ids":[],"participating":false}`, `{"store_id":"store","product_ids":[],"cursor":"token"}`, `{"store_id":"store","product_ids":[],"action_id":12,"participating":null}`, `{"store_id":"store","product_ids":[],"action_id":12,"participating":false,"cursor":"bad\nvalue"}`,
	} {
		req, err := DecodePromotions([]byte(raw))
		if err == nil && ValidatePromotions(req) == nil {
			t.Fatalf("invalid request accepted: %s", raw)
		}
	}
}

func TestPromotionSelectionStopsAfterExactActiveTargets(t *testing.T) {
	read := promotionReadFixture{actions: []contract.PromotionAction{{ActionID: 7, Title: "Campaign", ParticipatingProductsTotal: 108, PotentialProductsTotal: 55}}}
	read.products = func(_ int64, joined bool, _ string) (contract.PromotionPage, *contract.Fail) {
		if !joined {
			t.Fatal("selected active target scanned unrelated candidates")
		}
		return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 41, Participating: true}}, Total: 108, NextCursor: "more"}, nil
	}
	raw, fail := Promotions(PromotionsRequest{ProductIDs: []int64{41}}, read)
	if fail != nil || !strings.Contains(string(raw), `"participating":true`) {
		t.Fatalf("selection=%s fail=%v", raw, fail)
	}
}

func TestPromotionTargetScanStillRejectsRepeatedPagesBeforeTargetCompletion(t *testing.T) {
	read := promotionReadFixture{}
	read.products = func(_ int64, _ bool, cursor string) (contract.PromotionPage, *contract.Fail) {
		if cursor == "" {
			return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 1}}, Total: 100, NextCursor: "next"}, nil
		}
		return contract.PromotionPage{Offers: []contract.PromotionOffer{{ProductID: 1}, {ProductID: 99}}, Total: 100, NextCursor: "tail"}, nil
	}
	rows, fail := promotionProductsFor(7, true, map[int64]bool{99: true}, read)
	if fail == nil || fail.Status != 502 || rows != nil {
		t.Fatalf("duplicate page accepted: rows=%+v fail=%v", rows, fail)
	}
}
