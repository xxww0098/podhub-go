package service

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

func TestProductExportCSVKeepsFactsAndNeutralizesCells(t *testing.T) {
	name, sku, price, stock, state := " \t=HYPERLINK(\"x\")", "1234567890123456", "12.50", "0", "on_sale"
	stamp := int64(1700000000000)
	raw, api := productExportCSV([]domain.ProductExportRow{{
		Name: &name, OfferID: "+offer", SKU: &sku, StoreName: "主店,\"A\"", Price: &price,
		Currency: "USD", Stock: &stock, State: &state, SnapshotAtMS: &stamp,
	}, {OfferID: "unknown", Gone: true}})
	if api != nil || !bytes.HasPrefix(raw, []byte("\uFEFF")) {
		t.Fatalf("export: %v", api)
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(raw), "\uFEFF"))).ReadAll()
	if err != nil || len(rows) != 3 {
		t.Fatalf("readback rows=%v err=%v", rows, err)
	}
	want := []string{"'" + name, "'+offer", "'" + sku, "主店,\"A\"", "12.50", "USD", "0", "在售", "2023-11-14T22:13:20Z"}
	for i, cell := range want {
		if rows[1][i] != cell {
			t.Fatalf("cell %d=%q want %q", i, rows[1][i], cell)
		}
	}
	if rows[2][0] != "" || rows[2][4] != "" || rows[2][7] != "已下架" || rows[2][8] != "" {
		t.Fatalf("unknown facts invented: %v", rows[2])
	}
}

func TestProductExportRejectsRowLimitBeforeReturningCSV(t *testing.T) {
	raw, api := productExportCSV(make([]domain.ProductExportRow, domain.MaxProductExportRows+1))
	if len(raw) != 0 || api == nil || api.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized export returned bytes=%d api=%v", len(raw), api)
	}
}
