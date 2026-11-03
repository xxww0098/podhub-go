package readhttp

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMediaInputFingerprintIgnoresUnrelatedRevision(t *testing.T) {
	source, template := strings.Repeat("a", 64), strings.Repeat("b", 64)
	row := storedScan{row: StoredRow{Revision: 2, Payload: []byte(`{"source":{"sha256":"` + source + `"}}`)}}
	card := []byte(`{"psdTemplateSha256":"` + template + `","psdTemplateAssetId":"template-a","supplierProductId":"product-a"}`)
	first, err := mediaInput(row, card, "browser-wasm-v2")
	if err != nil {
		t.Fatal(err)
	}
	row.row.Revision = 9
	second, err := mediaInput(row, card, "browser-wasm-v2")
	if err != nil {
		t.Fatal(err)
	}
	if pinFingerprint(first) != pinFingerprint(second) {
		t.Fatal("an unrelated draft edit invalidated immutable rendering")
	}
	for _, edit := range []func(*mediaPin){func(p *mediaPin) { p.SourceSHA = strings.Repeat("c", 64) }, func(p *mediaPin) { p.TemplateSHA = strings.Repeat("c", 64) }, func(p *mediaPin) { p.Renderer = "new" }, func(p *mediaPin) { p.ManifestDigest = "other" }} {
		changed := first
		edit(&changed)
		if pinFingerprint(changed) == pinFingerprint(first) {
			t.Fatal("changed rendering input retained its fence")
		}
	}
}
func TestMediaRenderRejectsUnboundedOrAlreadyPublicImages(t *testing.T) {
	good := mediaImage{Index: 0, FileName: "slice.png", ContentHash: strings.Repeat("a", 64), Group: "hero", Width: 20, Height: 20, Bytes: 128, Phase: "rendered"}
	if !validRenderImages([]mediaImage{good}) {
		t.Fatal("valid image refused")
	}
	for _, edit := range []func(*mediaImage){func(i *mediaImage) { i.Index = 1 }, func(i *mediaImage) { i.Bytes = 0 }, func(i *mediaImage) { i.Bytes = 20<<20 + 1 }, func(i *mediaImage) { i.Width = 64000001; i.Height = 1 }, func(i *mediaImage) { i.Phase = "public_ready" }, func(i *mediaImage) { v := "https://unverified.invalid"; i.PublicURL = &v }, func(i *mediaImage) { v := "forged"; i.AccountID = &v }, func(i *mediaImage) { i.ContentHash = "bad" }} {
		image := good
		edit(&image)
		if validRenderImages([]mediaImage{image}) {
			raw, _ := json.Marshal(image)
			t.Fatalf("invalid image accepted: %s", raw)
		}
	}
}
func TestMediaRequestRejectsTrailingAndUnknownInput(t *testing.T) {
	for _, body := range []string{`{"operation":"slice"} {}`, `{"operation":"slice","unexpected":true}`, `{"operation":"slice"} true`} {
		var dst struct {
			Operation string `json:"operation"`
		}
		if readMediaBody(httptest.NewRequest("POST", "/", strings.NewReader(body)), &dst) == nil {
			t.Fatal("accepted", body)
		}
	}
}
