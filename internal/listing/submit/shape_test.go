package submit

import "testing"

func TestParseInfoList(t *testing.T) {
	items, ok := parseInfoList(200, `{"items":[{"id":9,"offer_id":"a","sources":[{"sku":0},{"sku":4}]}]}`, nil)
	if !ok || len(items) != 1 || items[0].ProductID != 9 || items[0].OfferID != "a" || items[0].SKU != 4 {
		t.Fatalf("%+v %v", items, ok)
	}
	if _, ok := parseInfoList(500, `{"items":[]}`, nil); ok {
		t.Fatal("non-2xx is unreadable")
	}
	if _, ok := parseInfoList(200, `{`, nil); ok {
		t.Fatal("bad json is unreadable")
	}
}

func TestDraftShape(t *testing.T) {
	if IsDraft([]byte(`{"rules_version":"v","tags":[],"text":""}`)) {
		t.Fatal("tag gate is not a draft")
	}
	if !IsDraft([]byte(`{"store_id":"s","card_id":"c","items":[{}]}`)) {
		t.Fatal("draft")
	}
	if !IsDraft([]byte(`{"store_id":"s"}`)) || IsDraft([]byte(`{"storeId":"s"}`)) {
		t.Fatal("only the snake_case store field selects the draft branch")
	}
	peek, err := PeekDraft([]byte(`{"store_id":"s","card_id":"c","rules_version":"v","items":[{},{}]}`))
	if err != nil || peek.Items != 2 || peek.StoreID != "s" || peek.CardID != "c" || peek.RulesVersion != "v" {
		t.Fatalf("%+v %v", peek, err)
	}
	if _, err := ParseBatch([]byte(`{"store_id":"","row_ids":[]}`)); err != ErrStoreRequired {
		t.Fatal(err)
	}
	if _, err := ParseBatch([]byte(`{"store_id":"nope","row_ids":["00000000-0000-0000-0000-000000000001"]}`)); err != ErrStoreInvalid {
		t.Fatal(err)
	}
	id := "00000000-0000-0000-0000-000000000001"
	got, err := ParseBatch([]byte(`{"store_id":"` + id + `","row_ids":["` + id + `"],"expected_revisions":[{"row_id":"` + id + `","revision":1}]}`))
	if err != nil || len(got.RowIDs) != 1 {
		t.Fatal(err, got)
	}
	if _, err := ParseBatch([]byte(`{"store_id":"` + id + `","row_ids":["nope"]}`)); err != ErrBadRequest {
		t.Fatal(err)
	}
}

func TestIsBatchRoutesBeforeDraft(t *testing.T) {
	if !IsBatch([]byte(`{"store_id":"s","row_ids":["00000000-0000-0000-0000-000000000001"]}`)) {
		t.Fatal("row_ids is the batch form")
	}
	if IsBatch([]byte(`{"store_id":"s","card_id":"c","items":[{}]}`)) {
		t.Fatal("a draft is not the batch form")
	}
	if IsBatch([]byte(`{"rules_version":"v"}`)) {
		t.Fatal("a tag check is not the batch form")
	}
}
