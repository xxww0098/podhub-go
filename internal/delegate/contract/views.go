package contract

import "encoding/json"

// Source is SellerSupplierDbData. Field order is the serde struct order.
type Source struct {
	SourceID string `json:"source_id"`
	Name     string `json:"name"`
	Country  string `json:"country"`
	Icon     string `json:"icon"`
}

// Asset is DelegateAssetView.
type Asset struct {
	AssetID      string `json:"asset_id"`
	BindingID    string `json:"binding_id"`
	FileName     string `json:"file_name"`
	SHA256       string `json:"sha256"`
	Bytes        int64  `json:"bytes"`
	Mime         string `json:"mime"`
	Position     int32  `json:"position"`
	Verified     bool   `json:"verified"`
	VerifiedAtMS *int64 `json:"verified_at_ms,omitempty"`
	CreatedAtMS  int64  `json:"created_at_ms"`
}

// Binding is DelegateBindingData.
type Binding struct {
	BindingID   string  `json:"binding_id"`
	StoreID     string  `json:"store_id"`
	OfferID     string  `json:"offer_id"`
	Source      Source  `json:"source"`
	Note        string  `json:"note"`
	Active      bool    `json:"active"`
	Revision    int64   `json:"revision"`
	Assets      []Asset `json:"assets"`
	Warning     *string `json:"warning,omitempty"`
	CreatedAtMS int64   `json:"created_at_ms"`
	UpdatedAtMS int64   `json:"updated_at_ms"`
}

// OrderLine is DelegateOrderLineView.
type OrderLine struct {
	LineID      string  `json:"line_id"`
	OfferID     string  `json:"offer_id"`
	SKU         int64   `json:"sku"`
	Name        string  `json:"name"`
	Quantity    int32   `json:"quantity"`
	Source      *Source `json:"source,omitempty"`
	PacketState *string `json:"packet_state,omitempty"`
}

// Order is DelegateOrderView.
type Order struct {
	OrderID         string          `json:"order_id"`
	StoreID         string          `json:"store_id"`
	PostingNumber   string          `json:"posting_number"`
	SellerNote      string          `json:"seller_note"`
	State           string          `json:"state"`
	CancelRequested bool            `json:"cancel_requested"`
	PostingSnapshot json.RawMessage `json:"posting_snapshot"`
	Logistics       json.RawMessage `json:"logistics,omitempty"`
	Lines           []OrderLine     `json:"lines"`
	CreatedAtMS     int64           `json:"created_at_ms"`
	UpdatedAtMS     int64           `json:"updated_at_ms"`
	HeldCents       int64           `json:"held_cents"`
	SettledCents    int64           `json:"settled_cents"`
	NudgeCount      int32           `json:"nudge_count"`
	NudgedAtMS      *int64          `json:"nudged_at_ms,omitempty"`
	// DispatchBlockedReason is set when the order is ready but the platform
	// could not decide which fulfiller receives the packet. Empty otherwise.
	DispatchBlockedReason string `json:"dispatch_blocked_reason,omitempty"`
}

// PostingProductView is DelegatePostingsProductView.
type PostingProductView struct {
	SKU      int64  `json:"sku"`
	OfferID  string `json:"offer_id"`
	Name     string `json:"name"`
	Quantity int32  `json:"quantity"`
}

// PostingView is DelegatePostingView.
type PostingView struct {
	PostingNumber string               `json:"posting_number"`
	InProcessAt   string               `json:"in_process_at"`
	ShipmentDate  string               `json:"shipment_date"`
	Status        string               `json:"status"`
	Substatus     string               `json:"substatus"`
	Quantity      int32                `json:"quantity"`
	Products      []PostingProductView `json:"products"`
	DelegateState string               `json:"delegate_state"`
	CoveredLines  int64                `json:"covered_lines"`
	TotalLines    int64                `json:"total_lines"`
	OrderID       *string              `json:"order_id,omitempty"`
	OrderState    *string              `json:"order_state,omitempty"`
}

// PostingStateView is DelegatePostingStateView.
type PostingStateView struct {
	PostingNumber   string   `json:"posting_number"`
	State           string   `json:"state"`
	CoveredOfferIDs []string `json:"covered_offer_ids"`
	OrderID         *string  `json:"order_id,omitempty"`
	OrderState      *string  `json:"order_state,omitempty"`
}

// UploadHeaders is DirectUploadHeaders.
type UploadHeaders struct {
	ContentType    string  `json:"content_type"`
	IfNoneMatch    string  `json:"if_none_match"`
	ChecksumSHA256 *string `json:"checksum_sha256,omitempty"`
}

// UploadGrant is DirectUploadGrant.
type UploadGrant struct {
	URL         string        `json:"url"`
	Headers     UploadHeaders `json:"headers"`
	ExpiresAtMS int64         `json:"expires_at_ms"`
}

// UploadTarget is DelegateAssetUploadTarget.
type UploadTarget struct {
	ObjectKey    string      `json:"object_key"`
	Upload       UploadGrant `json:"upload"`
	UploadTicket string      `json:"upload_ticket"`
}
