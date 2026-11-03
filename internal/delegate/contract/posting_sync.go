package contract

import "encoding/json"

// SyncTarget freezes the local order identity and version before an external read.
type SyncTarget struct {
	OrderID, StoreID, PostingNumber string
	UpdatedAtMS                     int64
}

// PostingUpdate contains only the whitelisted Seller facts used by fulfillment.
type PostingUpdate struct {
	Status              string
	Snapshot, Logistics json.RawMessage
}
