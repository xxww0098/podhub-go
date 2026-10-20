package domain

import "encoding/json"

// ProductionFile is one production asset. contentHash is omitted when nil.
type ProductionFile struct {
	MediaAssetID string  `json:"mediaAssetId"`
	ContentHash  *string `json:"contentHash,omitempty"`
}

// Attempt is one procurement row. Optional fields serialize as null.
type Attempt struct {
	ProcurementID   string  `json:"procurementId"`
	OperationID     string  `json:"operationId"`
	Attempt         int32   `json:"attempt"`
	Status          string  `json:"status"`
	SourceID        *string `json:"sourceId"`
	ChannelSKU      *string `json:"channelSku"`
	CostCents       *int64  `json:"supplierCostSnapshotCents"`
	ChannelOrderRef *string `json:"channelOrderRef"`
	RejectReason    *string `json:"rejectReason"`
	ClaimedBy       *string `json:"claimedByAccountUuid"`
	ClaimedAtMS     *int64  `json:"claimedAtMs"`
	LeaseUntilMS    *int64  `json:"leaseUntilMs"`
	DispatchedAtMS  *int64  `json:"dispatchedAtMs"`
	ReceiptAtMS     *int64  `json:"receiptAtMs"`
	CreatedAtMS     int64   `json:"createdAtMs"`
	UpdatedAtMS     int64   `json:"updatedAtMs"`
}

// WorkItem is one admin procurement row.
type WorkItem struct {
	OrderID         string           `json:"orderId"`
	OrgID           int64            `json:"orgId"`
	LineNo          int32            `json:"lineNo"`
	ListingRowID    string           `json:"listingRowId"`
	PlatformSKUID   string           `json:"platformSkuId"`
	ProductionFiles []ProductionFile `json:"productionFiles"`
	Quantity        int64            `json:"quantity"`
	AmountCents     int64            `json:"amountCents"`
	Currency        string           `json:"currency"`
	OrderStatus     string           `json:"orderStatus"`
	RefundAtMS      *int64           `json:"refundRequestedAtMs"`
	Procurement     *Attempt         `json:"procurement"`
	CreatedAtMS     int64            `json:"createdAtMs"`
	UpdatedAtMS     int64            `json:"updatedAtMs"`
}

// WorkList is the list envelope.
type WorkList struct {
	Data struct {
		Items []WorkItem `json:"items"`
	} `json:"data"`
}

// WorkItemResponse wraps one item.
type WorkItemResponse struct {
	Data struct {
		Item WorkItem `json:"item"`
	} `json:"data"`
}

// RefundResponse is the refund stamp.
type RefundResponse struct {
	Data struct {
		OrderID    string `json:"orderId"`
		RefundAtMS int64  `json:"refundRequestedAtMs"`
	} `json:"data"`
}

func jsonUnmarshal(raw []byte, dest any) error {
	return json.Unmarshal(raw, dest)
}

// FillWork guarantees a JSON array for production files.
func FillWork(item WorkItem) WorkItem {
	if item.ProductionFiles == nil {
		item.ProductionFiles = []ProductionFile{}
	}
	if item.LineNo == 0 {
		item.LineNo = 1
	}
	return item
}
