package contract

import "encoding/json"

// OrderQuery is the admin queue filter after validation.
type OrderQuery struct {
	State    string
	SourceID string
	OrgID    int64
	CursorMS *int64
	CursorID string
	Limit    int64
}

// SourceView is a factory card.
type SourceView struct {
	SourceID string `json:"sourceId"`
	Name     string `json:"name"`
	Country  string `json:"country"`
	Icon     string `json:"icon"`
}

// ReceiptView is the ledger receipt. Empty strings and a non-number atMs are omitted.
type ReceiptView struct {
	TrackingNo *string `json:"trackingNo,omitempty"`
	Note       *string `json:"note,omitempty"`
	Reason     *string `json:"reason,omitempty"`
	RecordedBy *string `json:"recordedBy,omitempty"`
	AtMs       *int64  `json:"atMs,omitempty"`
}

// OrderRow is one queue row.
type OrderRow struct {
	OrderID         string   `json:"orderId"`
	OrgID           int64    `json:"orgId"`
	StoreID         string   `json:"storeId"`
	PostingNumber   string   `json:"postingNumber"`
	State           string   `json:"state"`
	CancelRequested bool     `json:"cancelRequested"`
	LineCount       int64    `json:"lineCount"`
	SourceNames     []string `json:"sourceNames"`
	CreatedAtMs     int64    `json:"createdAtMs"`
	UpdatedAtMs     int64    `json:"updatedAtMs"`
}

// OrderListResponse is the queue envelope. Cursor is "" on the last page.
type OrderListResponse struct {
	Data struct {
		Orders  []OrderRow `json:"orders"`
		HasNext bool       `json:"hasNext"`
		Cursor  string     `json:"cursor"`
	} `json:"data"`
}

// LineView is one order line.
type LineView struct {
	LineID      string      `json:"lineId"`
	OfferID     string      `json:"offerId"`
	SKU         int64       `json:"sku"`
	Name        string      `json:"name"`
	Quantity    int32       `json:"quantity"`
	Source      *SourceView `json:"source,omitempty"`
	PacketState *string     `json:"packetState,omitempty"`
}

// OrderView is the nested order object.
type OrderView struct {
	OrderID         string          `json:"orderId"`
	StoreID         string          `json:"storeId"`
	PostingNumber   string          `json:"postingNumber"`
	SellerNote      string          `json:"sellerNote"`
	State           string          `json:"state"`
	CancelRequested bool            `json:"cancelRequested"`
	PostingSnapshot json.RawMessage `json:"postingSnapshot"`
	Logistics       json.RawMessage `json:"logistics,omitempty"`
	Lines           []LineView      `json:"lines"`
	CreatedAtMs     int64           `json:"createdAtMs"`
	UpdatedAtMs     int64           `json:"updatedAtMs"`
	HeldCents       int64           `json:"heldCents"`
	SettledCents    int64           `json:"settledCents"`
	NudgeCount      int32           `json:"nudgeCount"`
	NudgedAtMs      *int64          `json:"nudgedAtMs,omitempty"`
}

// LedgerRow is one dispatch on the admin detail.
type LedgerRow struct {
	DispatchID  string       `json:"dispatchId"`
	DispatchNo  string       `json:"dispatchNo"`
	Source      SourceView   `json:"source"`
	State       string       `json:"state"`
	AttemptedBy string       `json:"attemptedBy"`
	LineCount   int64        `json:"lineCount"`
	Receipt     *ReceiptView `json:"receipt,omitempty"`
	CreatedAtMs int64        `json:"createdAtMs"`
	UpdatedAtMs int64        `json:"updatedAtMs"`
}

// OrderDetailResponse is GET detail and the three writes once they are ported.
type OrderDetailResponse struct {
	Data struct {
		Order struct {
			Order  OrderView   `json:"order"`
			Ledger []LedgerRow `json:"ledger"`
		} `json:"order"`
	} `json:"data"`
}
