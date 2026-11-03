package domain

const MaxProductExportRows = 50_000
const MaxProductExportBytes = 64 * 1024 * 1024

type ProductExportRow struct {
	Name, SKU, Price, Stock, State *string
	OfferID, StoreName, Currency   string
	Gone                           bool
	SnapshotAtMS                   *int64
}
