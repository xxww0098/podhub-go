package contract

type PromotionAction struct {
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

type PromotionOffer struct {
	ActionID          int64    `json:"action_id"`
	ProductID         int64    `json:"product_id"`
	Participating     bool     `json:"participating"`
	OfferID           string   `json:"offer_id"`
	Name              string   `json:"name"`
	SKU               string   `json:"sku"`
	Price             string   `json:"price"`
	PriceCurrencyCode string   `json:"price_currency_code"`
	ActionPrice       string   `json:"action_price"`
	MaxActionPrice    string   `json:"max_action_price"`
	CurrencyCode      string   `json:"currency_code"`
	AddMode           string   `json:"add_mode"`
	Stock             *int64   `json:"stock"`
	MinStock          *int64   `json:"min_stock"`
	CurrentBoost      *float64 `json:"current_boost"`
	MinBoost          *float64 `json:"min_boost"`
	MaxBoost          *float64 `json:"max_boost"`
	PriceMinElastic   string   `json:"price_min_elastic"`
	PriceMaxElastic   string   `json:"price_max_elastic"`
	PriceQuarantined  *bool    `json:"price_quarantined"`
}

type PromotionPage struct {
	Offers     []PromotionOffer
	Total      int64
	NextCursor string
}

type PromotionIdentity struct {
	ProductID          int64
	OfferID, Name, SKU string
}

type PromotionPrice struct {
	ProductID                    int64
	OfferID, Price, CurrencyCode string
}

// PromotionRead is bound to an admitted store and read lane by app.
type PromotionRead interface {
	Actions() ([]PromotionAction, *Fail)
	Products(actionID int64, participating bool, cursor string) (PromotionPage, *Fail)
	Details(ids []int64) ([]PromotionIdentity, *Fail)
	Prices(ids []int64) ([]PromotionPrice, *Fail)
}
