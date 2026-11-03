package contract

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const (
	PromotionActionsPath    = "/v1/actions"
	PromotionProductsPath   = "/v2/actions/products"
	PromotionCandidatesPath = "/v2/actions/candidates"
)

var ErrPromotionRead = errors.New("invalid Ozon promotion response")
var promotionAmount = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)?$`)
var promotionCurrency = regexp.MustCompile(`^[A-Z]{3}$`)

type PromotionAction struct {
	ID, PotentialProducts, ParticipatingProducts int64
	Title, Type, DateStart, DateEnd, FreezeDate  string
	Participating                                bool
}

type PromotionMoney struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

type PromotionProduct struct {
	ID               int64
	Price            PromotionMoney  `json:"price"`
	ActionPrice      PromotionMoney  `json:"action_price"`
	MaxActionPrice   PromotionMoney  `json:"max_action_price"`
	AddMode          string          `json:"add_mode"`
	Stock            *int64          `json:"stock"`
	MinStock         *int64          `json:"min_stock"`
	CurrentBoost     *float64        `json:"current_boost"`
	MinBoost         *float64        `json:"min_boost"`
	MaxBoost         *float64        `json:"max_boost"`
	PriceMinElastic  *PromotionMoney `json:"price_min_elastic"`
	PriceMaxElastic  *PromotionMoney `json:"price_max_elastic"`
	PriceQuarantined *bool           `json:"is_quarantined"`
}

type PromotionProductPage struct {
	Products []PromotionProduct
	Total    int64
	LastID   string
}

// Promotion APIs use both numeric and textual identifiers. Parse without a float.
func promotionID(raw json.Number) (int64, bool) {
	if len(raw) == 0 || len(raw) > 32 {
		return 0, false
	}
	n, ok := new(big.Rat).SetString(string(raw))
	if !ok || !n.IsInt() || !n.Num().IsInt64() || n.Sign() <= 0 || n.Num().Int64() > 9007199254740991 {
		return 0, false
	}
	return n.Num().Int64(), true
}

func ParsePromotionActions(body []byte) ([]PromotionAction, error) {
	var source struct {
		Result *[]struct {
			ID                    json.Number `json:"id"`
			Title                 string      `json:"title"`
			Type                  string      `json:"action_type"`
			DateStart             string      `json:"date_start"`
			DateEnd               string      `json:"date_end"`
			FreezeDate            *string     `json:"freeze_date"`
			Participating         *bool       `json:"is_participating"`
			PotentialProducts     *int64      `json:"potential_products_count"`
			ParticipatingProducts *int64      `json:"participating_products_count"`
		} `json:"result"`
	}
	if json.Unmarshal(body, &source) != nil || source.Result == nil {
		return nil, ErrPromotionRead
	}
	out := make([]PromotionAction, 0, len(*source.Result))
	seen := map[int64]bool{}
	for _, row := range *source.Result {
		id, ok := promotionID(row.ID)
		if !ok || seen[id] || strings.TrimSpace(row.Title) == "" || row.Type == "" || row.FreezeDate == nil || row.Participating == nil || row.PotentialProducts == nil || row.ParticipatingProducts == nil || *row.PotentialProducts < 0 || *row.ParticipatingProducts < 0 {
			return nil, ErrPromotionRead
		}
		seen[id] = true
		out = append(out, PromotionAction{ID: id, Title: row.Title, Type: row.Type, DateStart: row.DateStart, DateEnd: row.DateEnd, FreezeDate: *row.FreezeDate,
			Participating: *row.Participating, PotentialProducts: *row.PotentialProducts, ParticipatingProducts: *row.ParticipatingProducts})
	}
	return out, nil
}

func validPromotionMoney(m PromotionMoney) bool {
	return len(m.Amount) <= 64 && promotionAmount.MatchString(m.Amount) && promotionCurrency.MatchString(m.Currency)
}

func ParsePromotionProducts(body []byte) (PromotionProductPage, error) {
	var source struct {
		Products *[]struct {
			PromotionProduct
			ProductID json.Number `json:"id"`
		} `json:"products"`
		Total  *int64 `json:"total"`
		LastID string `json:"last_id"`
	}
	if json.Unmarshal(body, &source) != nil || source.Products == nil || source.Total == nil || *source.Total < 0 || len(*source.Products) > 100 || int64(len(*source.Products)) > *source.Total || len(source.LastID) > 256 || strings.IndexFunc(source.LastID, unicode.IsControl) >= 0 {
		return PromotionProductPage{}, ErrPromotionRead
	}
	out := PromotionProductPage{Products: make([]PromotionProduct, 0, len(*source.Products)), Total: *source.Total, LastID: source.LastID}
	seen := map[int64]bool{}
	for _, row := range *source.Products {
		id, ok := promotionID(row.ProductID)
		p := row.PromotionProduct
		if !ok || seen[id] || !validPromotionMoney(p.Price) || !validPromotionMoney(p.ActionPrice) || !validPromotionMoney(p.MaxActionPrice) || p.ActionPrice.Currency != p.MaxActionPrice.Currency {
			return PromotionProductPage{}, ErrPromotionRead
		}
		for _, n := range []*int64{p.Stock, p.MinStock} {
			if n != nil && *n < 0 {
				return PromotionProductPage{}, ErrPromotionRead
			}
		}
		for _, n := range []*float64{p.CurrentBoost, p.MinBoost, p.MaxBoost} {
			if n != nil && (math.IsNaN(*n) || math.IsInf(*n, 0) || *n < 0) {
				return PromotionProductPage{}, ErrPromotionRead
			}
		}
		for _, m := range []*PromotionMoney{p.PriceMinElastic, p.PriceMaxElastic} {
			if m != nil && (!validPromotionMoney(*m) || m.Currency != p.ActionPrice.Currency) {
				return PromotionProductPage{}, ErrPromotionRead
			}
		}
		seen[id] = true
		p.ID = id
		out.Products = append(out.Products, p)
	}
	return out, nil
}

type PromotionIdentity struct {
	ProductID          int64
	OfferID, Name, SKU string
}

// ParsePromotionDetails requires exact current Seller identities for the page.
func ParsePromotionDetails(body []byte, ids []int64) ([]PromotionIdentity, error) {
	var source struct {
		Items *[]struct {
			ID      json.Number `json:"id"`
			OfferID string      `json:"offer_id"`
			Name    string      `json:"name"`
			SKU     json.Number `json:"sku"`
			Sources []struct {
				SKU json.Number `json:"sku"`
			} `json:"sources"`
		} `json:"items"`
	}
	if json.Unmarshal(body, &source) != nil || source.Items == nil || len(*source.Items) != len(ids) {
		return nil, ErrPromotionRead
	}
	requested, seen := map[int64]bool{}, map[int64]bool{}
	for _, id := range ids {
		requested[id] = true
	}
	out := make([]PromotionIdentity, 0, len(ids))
	for _, row := range *source.Items {
		id, ok := promotionID(row.ID)
		if !ok || !requested[id] || seen[id] || strings.TrimSpace(row.OfferID) == "" || strings.TrimSpace(row.Name) == "" {
			return nil, ErrPromotionRead
		}
		seen[id] = true
		sku := string(row.SKU)
		if sku == "" && len(row.Sources) > 0 {
			sku = string(row.Sources[0].SKU)
		}
		// SKU is a uint64 protocol identifier, never a JavaScript number.
		if sku != "" {
			value, err := strconv.ParseUint(sku, 10, 64)
			if err != nil || value == 0 || strconv.FormatUint(value, 10) != sku {
				return nil, ErrPromotionRead
			}
		}
		out = append(out, PromotionIdentity{ProductID: id, OfferID: row.OfferID, Name: row.Name, SKU: sku})
	}
	return out, nil
}

type PromotionPrice struct {
	ProductID                    int64
	OfferID, Price, CurrencyCode string
}

func ParsePromotionPrices(body []byte, ids []int64) ([]PromotionPrice, error) {
	var source struct {
		Items *[]struct {
			ProductID json.Number `json:"product_id"`
			OfferID   string      `json:"offer_id"`
			Price     struct {
				Price    json.Number `json:"price"`
				Currency string      `json:"currency_code"`
			} `json:"price"`
		} `json:"items"`
		Total      *int64 `json:"total"`
		TotalItems *int64 `json:"total_items"`
	}
	if json.Unmarshal(body, &source) != nil || source.Items == nil || len(*source.Items) != len(ids) {
		return nil, ErrPromotionRead
	}
	for _, total := range []*int64{source.Total, source.TotalItems} {
		if total != nil && *total != int64(len(ids)) {
			return nil, ErrPromotionRead
		}
	}
	requested, seen := map[int64]bool{}, map[int64]bool{}
	for _, id := range ids {
		requested[id] = true
	}
	out := make([]PromotionPrice, 0, len(ids))
	for _, row := range *source.Items {
		id, ok := promotionID(row.ProductID)
		if !ok || !requested[id] || seen[id] || strings.TrimSpace(row.OfferID) == "" || !validPromotionMoney(PromotionMoney{string(row.Price.Price), row.Price.Currency}) {
			return nil, ErrPromotionRead
		}
		seen[id] = true
		out = append(out, PromotionPrice{ProductID: id, OfferID: row.OfferID, Price: string(row.Price.Price), CurrencyCode: row.Price.Currency})
	}
	return out, nil
}
