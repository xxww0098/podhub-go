package domain

import (
	"testing"
)

func TestNamedOrderEdgesAndIllegals(t *testing.T) {
	states := []string{"", "awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped", "cancelled"}
	legal := map[string]string{}
	for _, edge := range OrderEdges {
		legal[edge.From+"→"+edge.To] = edge.Name
	}
	if len(legal) != len(OrderEdges) {
		t.Fatal("duplicate named edge")
	}
	for _, from := range states {
		for _, to := range states {
			name, ok := LegalOrderEdge(from, to)
			key := from + "→" + to
			if want, named := legal[key]; named {
				if !ok || name != want {
					t.Fatalf("named %s got %s %v", key, name, ok)
				}
				continue
			}
			if ok {
				t.Fatalf("illegal edge accepted %s", key)
			}
		}
	}
}

func TestHashAndValidation(t *testing.T) {
	if RequestHash("a", "b") == RequestHash("ab") {
		t.Fatal("nul separator")
	}
	if RequestHash("quote") != RequestHash("quote") {
		t.Fatal("stable")
	}
	if _, err := ParseListingID("not-a-uuid"); err == nil {
		t.Fatal("uuid")
	}
	if _, err := IdempotencyKey("  "); err == nil {
		t.Fatal("blank key")
	}
	if _, err := IdempotencyKey(string(make([]rune, 65))); err == nil {
		t.Fatal("long key")
	}
	if err := Quantity(0); err == nil {
		t.Fatal("qty")
	}
	if err := Quantity(1000); err == nil {
		t.Fatal("qty max")
	}
	if err := Placeholder(0); err == nil {
		t.Fatal("placeholder")
	}
	if _, err := SKURequired("  "); err == nil {
		t.Fatal("sku")
	}
	id := "11111111-1111-4111-8111-111111111111"
	hash := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := ValidateFiles([]ProductionFile{{MediaAssetID: id, ContentHash: hash, HasHash: true}}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFiles([]ProductionFile{{MediaAssetID: "/tmp/a.png"}}); err == nil {
		t.Fatal("path")
	}
	if err := ValidateFiles([]ProductionFile{{MediaAssetID: "file:a"}}); err == nil {
		t.Fatal("file")
	}
	if err := ValidateFiles([]ProductionFile{{MediaAssetID: id, ContentHash: "sha256:zz", HasHash: true}}); err == nil {
		t.Fatal("hash")
	}
	if err := ValidateFiles(make([]ProductionFile, 21)); err == nil {
		t.Fatal("count")
	}
	if HasMaterial(nil) || !HasMaterial([]ProductionFile{{MediaAssetID: " " + id}}) {
		t.Fatal("material")
	}
	if !QuoteExpired(10, 10) || QuoteExpired(11, 10) {
		t.Fatal("expiry")
	}
	if !GalleryLocal(`C:\a`) || GalleryLocal("") || GalleryLocal(id) {
		t.Fatal("local")
	}
}
