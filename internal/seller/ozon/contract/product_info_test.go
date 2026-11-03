package contract

import "testing"

func TestProductInfoRequiresExplicitRequestedItems(t *testing.T) {
	for _, body := range []string{
		`{}`, `null`, `{"items":null}`, `{"result":{"items":[]}}`,
		`{"items":[{"id":0,"offer_id":"a"}]}`,
		`{"items":[{"id":1,"offer_id":"b"}]}`,
		`{"items":[{"id":1,"offer_id":"a"},{"id":2,"offer_id":"a"}]}`,
	} {
		if _, ok := ParseProductInfoList([]byte(body), []string{"a"}); ok {
			t.Errorf("unreadable response admitted: %s", body)
		}
	}
	items, ok := ParseProductInfoList([]byte(`{"items":[]}`), []string{"a"})
	if !ok || len(items) != 0 {
		t.Fatal("explicit absence rejected")
	}
	items, ok = ParseProductInfoList([]byte(`{"items":[{"id":9,"offer_id":"a","sources":[{"sku":0},{"sku":4}]}]}`), []string{"a"})
	if !ok || len(items) != 1 || items[0] != (ProductInfo{ProductID: 9, OfferID: "a", SKU: 4}) {
		t.Fatalf("valid product: %+v ok=%v", items, ok)
	}
}
