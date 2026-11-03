package contract

import "encoding/json"

// SupplierDb is the product library view.
type SupplierDb struct {
	SourceID        string          `json:"sourceId"`
	FactoryID       *string         `json:"factoryId,omitempty"`
	Name            string          `json:"name"`
	Country         string          `json:"country"`
	Contact         string          `json:"contact"`
	InternalNote    string          `json:"internalNote"`
	Listed          bool            `json:"listed"`
	Icon            string          `json:"icon"`
	AcceptsDelegate bool            `json:"acceptsDelegate"`
	ViewPrefs       json.RawMessage `json:"viewPrefs"`
	RowCount        int64           `json:"rowCount"`
	PublishedCount  int64           `json:"publishedCount"`
	CreatedAtMs     int64           `json:"createdAtMs"`
	UpdatedAtMs     int64           `json:"updatedAtMs"`
	CreatedBy       string          `json:"createdBy"`
	CreatorName     *string         `json:"creatorName,omitempty"`
	FulfillerEmail  *string         `json:"fulfillerEmail,omitempty"`
}

// Prop is SupplierDbPropDefData. The type key is "type".
type Prop struct {
	PropID        string          `json:"propId"`
	SourceID      string          `json:"sourceId"`
	Name          string          `json:"name"`
	Type          string          `json:"type"`
	Options       json.RawMessage `json:"options"`
	Position      int64           `json:"position"`
	SellerVisible bool            `json:"sellerVisible"`
	CreatedAtMs   int64           `json:"createdAtMs"`
	UpdatedAtMs   int64           `json:"updatedAtMs"`
}
