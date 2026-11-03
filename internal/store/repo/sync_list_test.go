package storerepo

import (
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

func TestSyncListRequestJSON(t *testing.T) {
	for _, tc := range []struct {
		archived bool
		cursor   string
		want     string
	}{
		{false, "", `{"filter":{"visibility":"ALL"},"limit":1000}`},
		{true, "next", `{"filter":{"visibility":"ARCHIVED"},"last_id":"next","limit":1000}`},
	} {
		got, err := json.Marshal(domain.ListRequest(tc.archived, tc.cursor))
		if err != nil || string(got) != tc.want {
			t.Fatalf("request = %s, error = %v; want %s", got, err, tc.want)
		}
	}
}

func TestDecodeListPageRequiresExplicitCursorAndItems(t *testing.T) {
	for _, tc := range []struct {
		name   string
		body   string
		valid  bool
		cursor string
	}{
		{"page", `{"result":{"items":[{"product_id":1,"offer_id":"a"}],"last_id":"next"}}`, true, "next"},
		{"empty", `{"result":{"items":[],"last_id":""}}`, true, ""},
		{"missing result", `{}`, false, ""},
		{"missing cursor", `{"result":{"items":[]}}`, false, ""},
		{"null cursor", `{"result":{"items":[],"last_id":null}}`, false, ""},
		{"missing items", `{"result":{"last_id":""}}`, false, ""},
		{"null items", `{"result":{"items":null,"last_id":""}}`, false, ""},
		{"invalid id", `{"result":{"items":[{"offer_id":"a"}],"last_id":""}}`, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			page, fault := decodeListPage(200, []byte(tc.body))
			if (fault == nil) != tc.valid || (tc.valid && page.LastID != tc.cursor) {
				t.Fatalf("page = %+v, fault = %+v", page, fault)
			}
		})
	}
}
