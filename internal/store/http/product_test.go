package storehttp

import (
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

func TestProductSKUWirePreservesDecimalIdentifiers(t *testing.T) {
	for _, tc := range []struct {
		sku  int64
		want string
	}{{777, "777"}, {1234567890123456789, "1234567890123456789"}, {0, ""}, {-1, ""}} {
		views := toProductRows([]domain.Product{{SKU: &tc.sku}})
		body, err := json.Marshal(views[0])
		if err != nil {
			t.Fatal(err)
		}
		var row map[string]json.RawMessage
		if err := json.Unmarshal(body, &row); err != nil {
			t.Fatal(err)
		}
		if tc.want == "" {
			if _, ok := row["sku"]; ok {
				t.Fatalf("invalid SKU %d rendered as %s", tc.sku, row["sku"])
			}
		} else if string(row["sku"]) != `"`+tc.want+`"` {
			t.Fatalf("SKU %d lost its decimal text: %s", tc.sku, row["sku"])
		}
	}
	if views := toProductRows([]domain.Product{{}}); views[0].SKU != nil {
		t.Fatal("unknown SKU must stay absent")
	}
}
