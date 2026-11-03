package contract

import "encoding/json"

// ImportImageURLs is the immutable image set sent with a product import.
func ImportImageURLs(body []byte) []string {
	var doc struct {
		Items []struct {
			Images    []string `json:"images"`
			Primary   string   `json:"primary_image"`
			Color     string   `json:"color_image"`
			Images360 []string `json:"images360"`
		} `json:"items"`
	}
	if json.Unmarshal(body, &doc) != nil {
		return nil
	}
	urls := []string{}
	seen := map[string]bool{}
	for _, item := range doc.Items {
		for _, raw := range append(append(item.Images, item.Images360...), item.Primary, item.Color) {
			if raw != "" && !seen[raw] {
				seen[raw] = true
				urls = append(urls, raw)
			}
		}
	}
	return urls
}

// PicturesFetched requires every frozen source URL in an explicit, error-free
// picture receipt. A task id or product id alone never proves image ingestion.
func PicturesFetched(body []byte, productID int64, expected []string) bool {
	var doc struct {
		Items []struct {
			ProductID int64              `json:"product_id"`
			Primary   []string           `json:"primary_photo"`
			Photo     []string           `json:"photo"`
			Color     []string           `json:"color_photo"`
			Photo360  []string           `json:"photo_360"`
			Errors    *[]json.RawMessage `json:"errors"`
		} `json:"items"`
	}
	if productID <= 0 || len(expected) == 0 || json.Unmarshal(body, &doc) != nil || len(doc.Items) != 1 {
		return false
	}
	item := doc.Items[0]
	if item.ProductID != productID || item.Errors == nil || len(*item.Errors) != 0 {
		return false
	}
	seen := map[string]bool{}
	for _, raw := range append(append(append(item.Primary, item.Photo...), item.Color...), item.Photo360...) {
		seen[raw] = true
	}
	// shortcut: rewritten CDN-only receipts stay unconfirmed until Ozon supplies source-level evidence.
	for _, raw := range expected {
		if raw == "" || !seen[raw] {
			return false
		}
	}
	return true
}
