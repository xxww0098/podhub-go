package contract

import (
	"encoding/json"
	"strings"
)

type ProductInfo struct {
	ProductID int64
	OfferID   string
	SKU       int64
}

// ParseProductInfoList distinguishes a verified absence from an unreadable response.
func ParseProductInfoList(body []byte, offers []string) ([]ProductInfo, bool) {
	var parsed struct {
		Items *[]struct {
			ID      int64  `json:"id"`
			OfferID string `json:"offer_id"`
			Sources []struct {
				SKU int64 `json:"sku"`
			} `json:"sources"`
		} `json:"items"`
	}
	if json.Unmarshal(body, &parsed) != nil || parsed.Items == nil {
		return nil, false
	}
	requested := make(map[string]bool, len(offers))
	for _, offer := range offers {
		requested[offer] = true
	}
	seen := make(map[string]bool, len(*parsed.Items))
	out := make([]ProductInfo, 0, len(*parsed.Items))
	for _, item := range *parsed.Items {
		if item.ID <= 0 || strings.TrimSpace(item.OfferID) == "" || !requested[item.OfferID] || seen[item.OfferID] {
			return nil, false
		}
		seen[item.OfferID] = true
		product := ProductInfo{ProductID: item.ID, OfferID: item.OfferID}
		for _, source := range item.Sources {
			if source.SKU > 0 {
				product.SKU = source.SKU
				break
			}
		}
		out = append(out, product)
	}
	return out, true
}
