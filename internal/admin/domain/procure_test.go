package domain

import "testing"

func TestProcureValidation(t *testing.T) {
	long := repeat("字", 129)
	ok128 := repeat("字", 128)
	cases := []struct {
		name string
		run  func() error
		msg  string
	}{
		{"empty claim", func() error { _, err := ParseClaim(nil); return err }, msgBadCatalogJSON},
		{"unknown claim field", func() error { _, err := ParseClaim([]byte(`{"orderId":"a","extra":1}`)); return err }, msgBadCatalogJSON},
		{"missing order", func() error { _, err := ParseClaim([]byte(`{}`)); return err }, msgBadCatalogJSON},
		{"blank order", func() error { _, err := ParseClaim([]byte(`{"orderId":"  "}`)); return err }, msgPickOrder},
		{"long source", func() error {
			_, err := ParseClaim([]byte(`{"orderId":"a","sourceId":"` + long + `"}`))
			return err
		}, msgRefLen},
		{"long sku", func() error {
			_, err := ParseClaim([]byte(`{"orderId":"a","channelSku":"` + long + `"}`))
			return err
		}, msgRefLen},
		{"negative cost", func() error {
			_, err := ParseClaim([]byte(`{"orderId":"a","supplierCostSnapshotCents":-1}`))
			return err
		}, msgCost},
		{"bad outcome", func() error { _, err := ParseReceipt([]byte(`{"outcome":"later"}`)); return err }, msgBadCatalogJSON},
		{"missing outcome", func() error { _, err := ParseReceipt([]byte(`{}`)); return err }, msgBadCatalogJSON},
		{"empty receipt", func() error { _, err := ParseReceipt(nil); return err }, msgBadCatalogJSON},
		{"long note", func() error {
			_, err := ParseReceipt([]byte(`{"outcome":"rejected","note":"` + long + `"}`))
			return err
		}, msgRefLen},
		{"long ref", func() error {
			_, err := ParseReceipt([]byte(`{"outcome":"accepted","channelOrderRef":"` + long + `"}`))
			return err
		}, msgRefLen},
		{"empty procurement id", func() error { _, err := RequireProcID("  "); return err }, msgPickProc},
		{"empty order id", func() error { _, err := RequireOrderID(""); return err }, msgPickOrder},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			ae, ok := err.(*APIError)
			if !ok || ae.Status != 400 || ae.Code != "VALIDATION" || ae.Message != tc.msg {
				t.Fatalf("%v", err)
			}
		})
	}

	got, err := ParseClaim([]byte(`{"orderId":" ord ","sourceId":"  ","channelSku":"` + ok128 + `","supplierCostSnapshotCents":0}`))
	if err != nil || got.OrderID != "ord" || got.SourceID != nil || got.Channel == nil || *got.Channel != ok128 || got.Cost == nil || *got.Cost != 0 {
		t.Fatalf("%+v %v", got, err)
	}
	rec, err := ParseReceipt([]byte(`{"outcome":"accepted","channelOrderRef":" DIY "}`))
	if err != nil || rec.Outcome != "accepted" || rec.Ref == nil || *rec.Ref != "DIY" {
		t.Fatalf("%+v %v", rec, err)
	}
	rec, err = ParseReceipt([]byte(`{"outcome":"unknown"}`))
	if err != nil || rec.Outcome != "unknown" || rec.Ref != nil || rec.Note != nil {
		t.Fatalf("%+v %v", rec, err)
	}
	id, err := RequireOrderID("  o1 ")
	if err != nil || id != "o1" {
		t.Fatal(err, id)
	}
}

func TestProductionFilesUnknownShape(t *testing.T) {
	if files := ProductionFiles([]byte(`{"nope":1}`)); len(files) != 0 {
		t.Fatal(files)
	}
	files := ProductionFiles([]byte(`[{"mediaAssetId":"m","contentHash":"h"}]`))
	if len(files) != 1 || files[0].MediaAssetID != "m" || files[0].ContentHash == nil || *files[0].ContentHash != "h" {
		t.Fatal(files)
	}
	files = ProductionFiles([]byte(`{"files":[{"mediaAssetId":"m2"}]}`))
	if len(files) != 1 || files[0].MediaAssetID != "m2" || files[0].ContentHash != nil {
		t.Fatal(files)
	}
}
