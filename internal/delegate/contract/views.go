package contract

import "encoding/json"

// Source is SellerSupplierDbData. Field order is the serde struct order.
type Source struct {
	SourceID string `json:"sourceId"`
	Name     string `json:"name"`
	Country  string `json:"country"`
	Icon     string `json:"icon"`
}

// Asset is DelegateAssetView.
type Asset struct {
	AssetID      string `json:"assetId"`
	BindingID    string `json:"bindingId"`
	FileName     string `json:"fileName"`
	SHA256       string `json:"sha256"`
	Bytes        int64  `json:"bytes"`
	Mime         string `json:"mime"`
	Position     int32  `json:"position"`
	Verified     bool   `json:"verified"`
	VerifiedAtMS *int64 `json:"verifiedAtMs,omitempty"`
	CreatedAtMS  int64  `json:"createdAtMs"`
}

// Binding is DelegateBindingData.
type Binding struct {
	BindingID   string  `json:"bindingId"`
	StoreID     string  `json:"storeId"`
	OfferID     string  `json:"offerId"`
	Source      Source  `json:"source"`
	Note        string  `json:"note"`
	Active      bool    `json:"active"`
	Revision    int64   `json:"revision"`
	Assets      []Asset `json:"assets"`
	Warning     *string `json:"warning,omitempty"`
	CreatedAtMS int64   `json:"createdAtMs"`
	UpdatedAtMS int64   `json:"updatedAtMs"`
}

// OrderLine is DelegateOrderLineView.
type OrderLine struct {
	LineID      string  `json:"lineId"`
	OfferID     string  `json:"offerId"`
	SKU         int64   `json:"sku"`
	Name        string  `json:"name"`
	Quantity    int32   `json:"quantity"`
	Source      *Source `json:"source,omitempty"`
	PacketState *string `json:"packetState,omitempty"`
}

// Order is DelegateOrderView.
type Order struct {
	OrderID         string          `json:"orderId"`
	StoreID         string          `json:"storeId"`
	PostingNumber   string          `json:"postingNumber"`
	SellerNote      string          `json:"sellerNote"`
	State           string          `json:"state"`
	CancelRequested bool            `json:"cancelRequested"`
	PostingSnapshot json.RawMessage `json:"postingSnapshot"`
	Logistics       json.RawMessage `json:"logistics,omitempty"`
	Lines           []OrderLine     `json:"lines"`
	CreatedAtMS     int64           `json:"createdAtMs"`
	UpdatedAtMS     int64           `json:"updatedAtMs"`
	HeldCents       int64           `json:"heldCents"`
	SettledCents    int64           `json:"settledCents"`
	NudgeCount      int32           `json:"nudgeCount"`
	NudgedAtMS      *int64          `json:"nudgedAtMs,omitempty"`
}

// PostingProductView is DelegatePostingsProductView.
type PostingProductView struct {
	SKU      int64  `json:"sku"`
	OfferID  string `json:"offerId"`
	Name     string `json:"name"`
	Quantity int32  `json:"quantity"`
}

// PostingView is DelegatePostingView.
type PostingView struct {
	PostingNumber string               `json:"postingNumber"`
	InProcessAt   string               `json:"inProcessAt"`
	ShipmentDate  string               `json:"shipmentDate"`
	Status        string               `json:"status"`
	Substatus     string               `json:"substatus"`
	Quantity      int32                `json:"quantity"`
	Products      []PostingProductView `json:"products"`
	DelegateState string               `json:"delegateState"`
	CoveredLines  int64                `json:"coveredLines"`
	TotalLines    int64                `json:"totalLines"`
	OrderID       *string              `json:"orderId,omitempty"`
	OrderState    *string              `json:"orderState,omitempty"`
}

// PostingStateView is DelegatePostingStateView.
type PostingStateView struct {
	PostingNumber   string   `json:"postingNumber"`
	State           string   `json:"state"`
	CoveredOfferIDs []string `json:"coveredOfferIds"`
	OrderID         *string  `json:"orderId,omitempty"`
	OrderState      *string  `json:"orderState,omitempty"`
}

// UploadHeaders is DirectUploadHeaders.
type UploadHeaders struct {
	ContentType    string  `json:"contentType"`
	IfNoneMatch    string  `json:"ifNoneMatch"`
	ChecksumSHA256 *string `json:"checksumSha256,omitempty"`
}

// UploadGrant is DirectUploadGrant.
type UploadGrant struct {
	URL         string        `json:"url"`
	Headers     UploadHeaders `json:"headers"`
	ExpiresAtMS int64         `json:"expiresAtMs"`
}

// UploadTarget is DelegateAssetUploadTarget.
type UploadTarget struct {
	ObjectKey    string      `json:"objectKey"`
	Upload       UploadGrant `json:"upload"`
	UploadTicket string      `json:"uploadTicket"`
}
