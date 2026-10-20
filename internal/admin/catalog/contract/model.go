package contract

import (
	"bytes"
	"encoding/json"
)

// Product is AdminPlatformProductData. Specs keys are sorted by encoding/json.
type Product struct {
	ProductID   string            `json:"productId"`
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Media       []string          `json:"media"`
	Specs       map[string]string `json:"specs"`
	Published   bool              `json:"published"`
	Revision    int64             `json:"revision"`
	CreatedAtMS int64             `json:"createdAtMs"`
	UpdatedAtMS int64             `json:"updatedAtMs"`
}

// SKU is AdminPlatformSkuData. Shipping fields are omitted when nil.
type SKU struct {
	SKUID                   string            `json:"skuId"`
	ProductID               string            `json:"productId"`
	PlatformCode            string            `json:"platformCode"`
	Title                   string            `json:"title"`
	Media                   []string          `json:"media"`
	Specs                   map[string]string `json:"specs"`
	LeadTime                string            `json:"leadTime"`
	Published               bool              `json:"published"`
	CurrentPriceCents       *int64            `json:"currentPriceCents"`
	CurrentPriceVersionID   *int64            `json:"currentPriceVersionId"`
	ShippingPresetID        *string           `json:"shippingPresetId,omitempty"`
	ShippingPresetName      *string           `json:"shippingPresetName,omitempty"`
	ShippingRequiredVersion *int64            `json:"shippingRequiredVersion,omitempty"`
	Revision                int64             `json:"revision"`
	CreatedAtMS             int64             `json:"createdAtMs"`
	UpdatedAtMS             int64             `json:"updatedAtMs"`
}

// ProductInput is a create or update body after strict JSON.
type ProductInput struct {
	Title       string
	Description string
	Media       []string
	Specs       map[string]string
	Revision    int64
	HasRevision bool
}

// SKUInput is a create or update body.
type SKUInput struct {
	ProductID    string
	PlatformCode string
	Title        string
	Media        []string
	Specs        map[string]string
	LeadTime     string
	Revision     int64
	HasRevision  bool
}

// ImageTarget is the row a publish or image route inspects.
type ImageTarget struct {
	Exists       bool
	Revision     int64
	Media        []string
	Managed      bool
	PriceCents   *int64
	Title        string
	Published    bool
	PlatformCode string
	MediaBad     bool
}

// FillProduct guarantees JSON arrays and objects, not null.
func FillProduct(p Product) Product {
	if p.Media == nil {
		p.Media = []string{}
	}
	if p.Specs == nil {
		p.Specs = map[string]string{}
	}
	return p
}

// FillSKU guarantees JSON arrays and objects, not null.
func FillSKU(s SKU) SKU {
	if s.Media == nil {
		s.Media = []string{}
	}
	if s.Specs == nil {
		s.Specs = map[string]string{}
	}
	return s
}

// ProductAudit is the success message for a product write.
func ProductAudit(title string, published bool, revision int64) string {
	raw, _ := marshal(struct {
		Summary   string `json:"summary"`
		Published bool   `json:"published"`
		Revision  int64  `json:"revision"`
	}{title, published, revision})
	return string(raw)
}

// SKUAudit is the success message for a SKU write.
func SKUAudit(title, code string, published bool, revision int64, price *int64) string {
	raw, _ := marshal(struct {
		Summary      string `json:"summary"`
		PlatformCode string `json:"platformCode"`
		Published    bool   `json:"published"`
		Revision     int64  `json:"revision"`
		PriceCents   *int64 `json:"priceCents"`
	}{title, code, published, revision, price})
	return string(raw)
}

// marshal encodes v like the admin domain helper: struct order, no HTML escape, no trailing newline.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
