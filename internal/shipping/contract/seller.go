package contract

// SellerReadiness is the seller-facing shipping readiness row. JSON field names
// are the wire contract: snake_case, because the SPA reads them verbatim.
type SellerReadiness struct {
	SKUID             string   `json:"sku_id"`
	PresetID          string   `json:"-"`
	PresetDisplayName *string  `json:"preset_display_name,omitempty"`
	RequiredVersion   *int64   `json:"required_version,omitempty"`
	PinnedVersion     *int64   `json:"pinned_version,omitempty"`
	Status            string   `json:"status"`
	InjectReady       bool     `json:"inject_ready"`
	Reasons           []string `json:"reasons"`
	WarehouseID       *int64   `json:"warehouse_id,omitempty"`
	DeliveryMethodID  *int64   `json:"delivery_method_id,omitempty"`
	InjectStatus      *string  `json:"inject_status,omitempty"`
}

// SellerBinding is one SKU -> preset binding read for a seller request.
type SellerBinding struct {
	SKUID           string
	PresetID        string
	PresetName      string
	RequiredVersion int64
}

// SellerInjection is the manual-injection fact used by EvaluateSellerReadiness.
// A nil pointer means no row exists yet.
type SellerInjection struct {
	PinnedVersion  *int64
	Status         string
	WarehouseID    *int64
	DeliveryID     *int64
	DeliveryStatus *string
}

// Seller reason codes are the subset safe for seller responses.
const (
	ReasonDeliveryMethodNotActive = "delivery_method_not_active"
	ReasonFailed                  = "failed"
	ReasonInjectNotAvailable      = "inject_not_available"
	ReasonMissingBind             = "missing_bind"
	ReasonNonIntegrated           = "non_integrated_unsupported"
	ReasonResultUnknown           = "result_unknown"
	ReasonShopNotInjected         = "shop_not_injected"
	ReasonStaleVersion            = "stale_version"
	ReasonWaiting                 = "waiting"
	ReasonWeightUnitUnpinned      = "weight_unit_unpinned"
	ReasonWritesDisabled          = "writes_disabled"
)
