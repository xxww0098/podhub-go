package contract

// PublicSKU is one anonymous catalog sku. Price fields are absent.
type PublicSKU struct {
	SKUID        string   `json:"skuId"`
	PlatformCode string   `json:"platformCode"`
	Title        string   `json:"title"`
	Media        []string `json:"media"`
	Specs        Object   `json:"specs"`
	LeadTime     string   `json:"leadTime,omitempty"`
}

// PublicProduct keeps description when it is not empty.
type PublicProduct struct {
	ProductID   string      `json:"productId"`
	Title       string      `json:"title"`
	Description string      `json:"description,omitempty"`
	Media       []string    `json:"media"`
	Specs       Object      `json:"specs"`
	SKUs        []PublicSKU `json:"skus"`
}

// PublicCatalogData is GET /api/public/platform-catalog data.
type PublicCatalogData struct {
	Products []PublicProduct `json:"products"`
}

// SellerSKU is a priced, published sku. publication is always "published".
type SellerSKU struct {
	SKUID              string   `json:"skuId"`
	PlatformCode       string   `json:"platformCode"`
	Title              string   `json:"title"`
	Media              []string `json:"media"`
	Specs              Object   `json:"specs"`
	PlatformPriceCents int64    `json:"platformPriceCents"`
	Available          bool     `json:"available"`
	Publication        string   `json:"publication"`
	LeadTime           string   `json:"leadTime,omitempty"`
}

// SellerProduct drops description. publication is always "published".
type SellerProduct struct {
	ProductID   string      `json:"productId"`
	Title       string      `json:"title"`
	Media       []string    `json:"media"`
	Specs       Object      `json:"specs"`
	Publication string      `json:"publication"`
	SKUs        []SellerSKU `json:"skus"`
}

// SellerCatalogData is GET /api/platform-catalog data.
type SellerCatalogData struct {
	Products []SellerProduct `json:"products"`
}

// ProductionFile is one binding or order file. A missing hash omits the key.
type ProductionFile struct {
	MediaAssetID string  `json:"mediaAssetId"`
	ContentHash  *string `json:"contentHash,omitempty"`
}

// BindingData is the seller binding body inside data.binding.
type BindingData struct {
	ListingRowID        string           `json:"listingRowId"`
	StoreID             string           `json:"storeId"`
	PlatformSKUID       string           `json:"platformSkuId"`
	SpecVersion         int64            `json:"specVersion"`
	DesignRevision      int64            `json:"designRevision"`
	ProductionFiles     []ProductionFile `json:"productionFiles"`
	QuantityPlaceholder int64            `json:"quantityPlaceholder"`
	CreatedAtMs         int64            `json:"createdAtMs"`
	UpdatedAtMs         int64            `json:"updatedAtMs"`
}

// QuoteData is data.quote.
type QuoteData struct {
	QuoteID                string `json:"quoteId"`
	StoreID                string `json:"storeId"`
	ListingRowID           string `json:"listingRowId"`
	PlatformSKUID          string `json:"platformSkuId"`
	PriceVersionID         int64  `json:"priceVersionId"`
	UnitPlatformPriceCents int64  `json:"unitPlatformPriceCents"`
	Quantity               int64  `json:"quantity"`
	AmountCents            int64  `json:"amountCents"`
	Currency               string `json:"currency"`
	ExpiresAtMs            int64  `json:"expiresAtMs"`
	CreatedAtMs            int64  `json:"createdAtMs"`
}

// OrderData is data.order. Status is one of the five seller literals.
type OrderData struct {
	OrderID                string           `json:"orderId"`
	StoreID                string           `json:"storeId"`
	ListingRowID           string           `json:"listingRowId"`
	PlatformSKUID          string           `json:"platformSkuId"`
	SpecVersion            int64            `json:"specVersion"`
	DesignRevision         int64            `json:"designRevision"`
	ProductionFiles        []ProductionFile `json:"productionFiles"`
	Quantity               int64            `json:"quantity"`
	UnitPlatformPriceCents int64            `json:"unitPlatformPriceCents"`
	AmountCents            int64            `json:"amountCents"`
	Currency               string           `json:"currency"`
	Status                 string           `json:"status"`
	PaymentOrderPublicID   string           `json:"paymentOrderPublicId"`
	CreatedAtMs            int64            `json:"createdAtMs"`
	UpdatedAtMs            int64            `json:"updatedAtMs"`
}
