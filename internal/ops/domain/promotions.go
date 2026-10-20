package domain

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const (
	actionsPath    = "/v1/actions"
	actionProducts = "/v2/actions/products"
	actionCands    = "/v2/actions/candidates"
	promoPageLimit = 100
	maxPromoPages  = 20
)

type PromotionsRequest struct {
	StoreID    string
	ProductIDs []int64
}

func DecodePromotions(raw []byte) (PromotionsRequest, error) {
	m, err := object(raw, "store_id", "product_ids")
	if err != nil {
		return PromotionsRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return PromotionsRequest{}, errJSON
	}
	req := PromotionsRequest{StoreID: store}
	rawIDs, ok := m["product_ids"]
	if !ok || json.Unmarshal(rawIDs, &req.ProductIDs) != nil {
		return PromotionsRequest{}, errJSON
	}
	return req, nil
}

// PositiveProducts drops non-positive ids. An empty result is a 200 before auth.
func PositiveProducts(ids []int64) []int64 {
	var out []int64
	seen := map[int64]struct{}{}
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func EmptyPromotions() json.RawMessage {
	return mustData(struct {
		Actions []promoAction `json:"actions"`
		Offers  []promoOffer  `json:"offers"`
	}{Actions: []promoAction{}, Offers: []promoOffer{}})
}

type promoAction struct {
	ActionID                   int64  `json:"action_id"`
	Title                      string `json:"title"`
	ActionType                 string `json:"action_type"`
	DateStart                  string `json:"date_start"`
	DateEnd                    string `json:"date_end"`
	FreezeDate                 string `json:"freeze_date"`
	IsParticipating            bool   `json:"is_participating"`
	EligibleSelected           int64  `json:"eligible_selected"`
	ParticipatingSelected      int64  `json:"participating_selected"`
	PotentialProductsTotal     int64  `json:"potential_products_total"`
	ParticipatingProductsTotal int64  `json:"participating_products_total"`
}

type promoOffer struct {
	ActionID        int64   `json:"action_id"`
	ProductID       int64   `json:"product_id"`
	Participating   bool    `json:"participating"`
	Price           float64 `json:"price"`
	ActionPrice     float64 `json:"action_price"`
	MaxActionPrice  float64 `json:"max_action_price"`
	AddMode         string  `json:"add_mode"`
	Stock           float64 `json:"stock"`
	MinStock        float64 `json:"min_stock"`
	CurrentBoost    float64 `json:"current_boost"`
	MinBoost        float64 `json:"min_boost"`
	MaxBoost        float64 `json:"max_boost"`
	PriceMinElastic float64 `json:"price_min_elastic"`
	PriceMaxElastic float64 `json:"price_max_elastic"`
}

func Promotions(ids []int64, fetch Fetch) (json.RawMessage, *contract.Fail) {
	page := fetch("GET", actionsPath, nil)
	if f := readPage(page, "读取 Ozon 平台活动", actionsPath, contract.CodeProducts); f != nil {
		return nil, f
	}
	root := asObject(page.Body)
	rows := arr(root, "result")
	want := map[int64]struct{}{}
	for _, id := range ids {
		want[id] = struct{}{}
	}
	var actions []promoAction
	var offers []promoOffer
	for _, row := range rows {
		id := fieldI64(row, "id")
		potential := fieldI64(row, "potential_products_count")
		participating := fieldI64(row, "participating_products_count")
		if id <= 0 || (potential <= 0 && participating <= 0) {
			continue
		}
		got, f := promoProducts(id, true, fetch)
		if f != nil {
			return nil, f
		}
		cands, f := promoProducts(id, false, fetch)
		if f != nil {
			return nil, f
		}
		seen := map[int64]struct{}{}
		var selected, joined int64
		for _, offer := range got {
			if _, ok := want[offer.ProductID]; !ok {
				continue
			}
			seen[offer.ProductID] = struct{}{}
			offer.Participating = true
			offers = append(offers, offer)
			selected++
			joined++
		}
		for _, offer := range cands {
			if _, ok := want[offer.ProductID]; !ok {
				continue
			}
			if _, ok := seen[offer.ProductID]; ok {
				continue
			}
			offer.Participating = false
			offers = append(offers, offer)
			selected++
		}
		if selected == 0 {
			continue
		}
		actions = append(actions, promoAction{
			ActionID: id, Title: fieldString(row, "title"), ActionType: fieldString(row, "action_type"),
			DateStart: fieldString(row, "date_start"), DateEnd: fieldString(row, "date_end"), FreezeDate: fieldString(row, "freeze_date"),
			IsParticipating:  fieldBool(row, "is_participating"),
			EligibleSelected: selected, ParticipatingSelected: joined,
			PotentialProductsTotal: potential, ParticipatingProductsTotal: participating,
		})
	}
	sort.Slice(actions, func(i, j int) bool {
		if actions[i].ParticipatingSelected != actions[j].ParticipatingSelected {
			return actions[i].ParticipatingSelected > actions[j].ParticipatingSelected
		}
		if actions[i].EligibleSelected != actions[j].EligibleSelected {
			return actions[i].EligibleSelected > actions[j].EligibleSelected
		}
		return actions[i].Title < actions[j].Title
	})
	if actions == nil {
		actions = []promoAction{}
	}
	if offers == nil {
		offers = []promoOffer{}
	}
	return mustData(struct {
		Actions []promoAction `json:"actions"`
		Offers  []promoOffer  `json:"offers"`
	}{Actions: actions, Offers: offers}), nil
}

func promoProducts(actionID int64, participating bool, fetch Fetch) ([]promoOffer, *contract.Fail) {
	path := actionCands
	op := "读取活动候选商品"
	if participating {
		path = actionProducts
		op = "读取活动已参加商品"
	}
	var out []promoOffer
	var last string
	for page := 0; page < maxPromoPages; page++ {
		body := map[string]any{"action_id": actionID, "limit": promoPageLimit}
		if last != "" {
			body["last_id"] = last
		}
		raw, _ := compact(body)
		got := fetch("POST", path, raw)
		if f := readPage(got, op, path, contract.CodeProducts); f != nil {
			return nil, f
		}
		root := asObject(got.Body)
		rows := arr(root, "products")
		if fieldBool(root, "has_next") || strings.TrimSpace(fieldString(root, "last_id")) != "" {
			if page == maxPromoPages-1 && (fieldBool(root, "has_next") || len(rows) >= promoPageLimit) {
				return nil, &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "活动商品超出读取页数上限，请稍后重试或缩小活动范围"}
			}
		}
		for _, row := range rows {
			id := fieldI64(row, "id")
			if id == 0 {
				id = fieldI64(row, "product_id")
			}
			price := moneyAmount(row, "price")
			action := moneyAmount(row, "action_price")
			maxp := moneyAmount(row, "max_action_price")
			if maxp < action {
				maxp = action
			}
			out = append(out, promoOffer{
				ActionID: actionID, ProductID: id, Participating: participating,
				Price: price, ActionPrice: action, MaxActionPrice: maxp,
				AddMode: fieldString(row, "add_mode"), Stock: fieldF64(row, "stock"), MinStock: fieldF64(row, "min_stock"),
				CurrentBoost: fieldF64(nested(row, "boosts"), "current"),
				MinBoost:     fieldF64(nested(row, "boosts"), "min"), MaxBoost: fieldF64(nested(row, "boosts"), "max"),
				PriceMinElastic: fieldF64(row, "price_min_elastic"), PriceMaxElastic: fieldF64(row, "price_max_elastic"),
			})
		}
		next := strings.TrimSpace(fieldString(root, "last_id"))
		if next == "" || next == last || len(rows) < promoPageLimit {
			return out, nil
		}
		last = next
	}
	return nil, &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "活动商品超出读取页数上限，请稍后重试或缩小活动范围"}
}

func moneyAmount(m map[string]json.RawMessage, key string) float64 {
	raw, ok := m[key]
	if !ok {
		return 0
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		if amt, ok := obj["amount"]; ok {
			var s string
			if json.Unmarshal(amt, &s) == nil {
				f, _ := strconv.ParseFloat(s, 64)
				return f
			}
			var n float64
			if json.Unmarshal(amt, &n) == nil {
				return n
			}
		}
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	return 0
}
