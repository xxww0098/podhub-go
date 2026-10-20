package supplyrepo

import (
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

func TestJSONSpecsAndSnapshot(t *testing.T) {
	if len(jsonSpecs([]byte(`{"b":"1","a":2}`))) != 0 {
		t.Fatal("mixed values must drop the map")
	}
	raw, err := json.Marshal(jsonSpecs([]byte(`{"b":"1","a":"2"}`)))
	if err != nil || string(raw) != `{"a":"2","b":"1"}` {
		t.Fatal(string(raw), err)
	}
	if got := jsonStrings([]byte(`[1,"a"]`)); len(got) != 0 {
		t.Fatal(got)
	}
	sku, spec, design, files, qty := readSnapshot([]byte(`{}`), "col", 4, 5)
	if sku != "col" || spec != 4 || design != 5 || len(files) != 0 || qty != 1 {
		t.Fatalf("%s %d %d %d %d", sku, spec, design, len(files), qty)
	}
	body, err := writeSnapshot("sku", 2, 3, []domain.ProductionFile{{MediaAssetID: "m"}}, 1)
	if err != nil || !json.Valid(body) || string(body) != `{"platformSkuId":"sku","specVersion":2,"designRevision":3,"productionFiles":[{"mediaAssetId":"m"}],"quantityPlaceholder":1}` {
		t.Fatal(string(body), err)
	}
}
