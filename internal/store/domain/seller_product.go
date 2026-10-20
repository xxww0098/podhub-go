package domain

import (
	"strconv"
	"strings"
)

// StatusTexts is the raw status vocabulary one Seller read carries. The listing
// pass reads none of it, and the empty combination classifies as hidden —
// never as on sale.
type StatusTexts struct {
	Status           string
	StatusName       string
	ModerateStatus   string
	ValidationStatus string
}

// SellerProduct is one row of POST /v3/product/info/list's `items`. Unknown
// fields are ignored: Ozon adds them without notice.
type SellerProduct struct {
	ID            int64    `json:"id"`
	OfferID       string   `json:"offer_id"`
	SKU           int64    `json:"sku"`
	Name          string   `json:"name"`
	Price         string   `json:"price"`
	OldPrice      string   `json:"old_price"`
	CurrencyCode  string   `json:"currency_code"`
	PrimaryImage  []string `json:"primary_image"`
	Images        []string `json:"images"`
	IsArchived    bool     `json:"is_archived"`
	IsAutoArchive bool     `json:"is_autoarchived"`
	Stocks        struct {
		Stocks []struct {
			Present  int64 `json:"present"`
			Reserved int64 `json:"reserved"`
		} `json:"stocks"`
	} `json:"stocks"`
	Statuses *struct {
		Status           string `json:"status"`
		StatusName       string `json:"status_name"`
		ModerateStatus   string `json:"moderate_status"`
		ValidationStatus string `json:"validation_status"`
	} `json:"statuses"`
	ModelInfo *struct {
		ModelID int64 `json:"model_id"`
		Count   int64 `json:"count"`
	} `json:"model_info"`
	DescriptionCategoryID int64 `json:"description_category_id"`
	TypeID                int64 `json:"type_id"`
}

// ProductFacts is what one Seller detail read says about a product, narrowed
// the way the mirror stores it: a zero Ozon uses as "absent" is dropped.
type ProductFacts struct {
	ProductID           int64
	OfferID             string
	SKU                 *int64
	Name                string
	Price               string
	OldPrice            string
	StockPresent        *int32
	StockReserved       *int32
	PrimaryImage        string
	Currency            string
	IsArchived          bool
	StatusTexts         StatusTexts
	ModelID             *int64
	ModelCount          *int64
	DescriptionCategory *int64
	TypeID              *int64
}

// Facts narrows one Seller row. A stored 0 can never read as a fact.
func (p SellerProduct) Facts() ProductFacts {
	facts := ProductFacts{
		ProductID: p.ID,
		OfferID:   p.OfferID,
		Name:      p.Name,
		Price:     strings.TrimSpace(p.Price),
		OldPrice:  strings.TrimSpace(p.OldPrice),
		Currency:  strings.TrimSpace(p.CurrencyCode),
	}
	if p.SKU > 0 {
		sku := p.SKU
		facts.SKU = &sku
	}
	if present, reserved, ok := p.stockTotals(); ok {
		facts.StockPresent = &present
		facts.StockReserved = &reserved
	}
	// Primary image, with the card's first image as the fallback. An empty
	// incoming list means the product really has no image, not "keep the old".
	for _, url := range append(append([]string{}, p.PrimaryImage...), p.Images...) {
		if trimmed := strings.TrimSpace(url); trimmed != "" {
			facts.PrimaryImage = trimmed
			break
		}
	}
	facts.IsArchived = p.IsArchived || p.IsAutoArchive
	if p.Statuses != nil {
		facts.StatusTexts = StatusTexts{
			Status:           p.Statuses.Status,
			StatusName:       p.Statuses.StatusName,
			ModerateStatus:   p.Statuses.ModerateStatus,
			ValidationStatus: p.Statuses.ValidationStatus,
		}
	}
	if p.ModelInfo != nil {
		if p.ModelInfo.ModelID > 0 {
			id := p.ModelInfo.ModelID
			facts.ModelID = &id
		}
		if p.ModelInfo.Count > 0 {
			count := p.ModelInfo.Count
			facts.ModelCount = &count
		}
	}
	if p.DescriptionCategoryID > 0 {
		id := p.DescriptionCategoryID
		facts.DescriptionCategory = &id
	}
	if p.TypeID > 0 {
		id := p.TypeID
		facts.TypeID = &id
	}
	return facts
}

// stockTotals sums every stock source (FBO, FBS, rFBS…): all of them can sell.
func (p SellerProduct) stockTotals() (int32, int32, bool) {
	if len(p.Stocks.Stocks) == 0 {
		return 0, 0, false
	}
	var present, reserved int64
	for _, stock := range p.Stocks.Stocks {
		present += stock.Present
		reserved += stock.Reserved
	}
	return clampInt32(present), clampInt32(reserved), true
}

func clampInt32(value int64) int32 {
	if value > 1<<31-1 {
		return 1<<31 - 1
	}
	if value < -1<<31 {
		return -1 << 31
	}
	return int32(value)
}

// ContentHash is the zero-write compare. It hashes the incoming facts, not the
// row after unknown-narrowing, so an unchanged payload issues no UPDATE.
func (f ProductFacts) ContentHash(statusID int16) int64 {
	parts := []string{
		strings.TrimSpace(f.OfferID),
		optionalInt(f.SKU),
		strings.TrimSpace(f.Name),
		strconv.Itoa(int(statusID)),
		f.Price,
		f.OldPrice,
		optionalInt32(f.StockPresent),
		optionalInt32(f.StockReserved),
		f.PrimaryImage,
		optionalInt(f.ModelID),
		optionalInt(f.ModelCount),
		optionalInt(f.DescriptionCategory),
		optionalInt(f.TypeID),
	}
	// FNV-1a over the parts, with a separator so ("ab","c") and ("a","bc")
	// cannot hash alike.
	var hash int64 = 1469598103934665603
	for _, part := range parts {
		for i := 0; i < len(part); i++ {
			hash ^= int64(part[i])
			hash *= 1099511628211
		}
		hash ^= 0xFF
		hash *= 1099511628211
	}
	return hash
}

func optionalInt(value *int64) string {
	if value == nil {
		return ""
	}
	return strconv.FormatInt(*value, 10)
}

func optionalInt32(value *int32) string {
	if value == nil {
		return ""
	}
	return strconv.FormatInt(int64(*value), 10)
}
