package contract

// SourceCard is one factory the signed-in member can see.
type SourceCard struct {
	SourceID string `json:"sourceId"`
	Name     string `json:"name"`
	Country  string `json:"country"`
	Icon     string `json:"icon"`
}

// MeData is GET /api/supplier/me data.
type MeData struct {
	Sources []SourceCard `json:"sources"`
}

// DispatchLine is a list row line.
type DispatchLine struct {
	OfferID  string `json:"offerId"`
	Name     string `json:"name"`
	Quantity int32  `json:"quantity"`
}

// DispatchRow is one page entry. Nil pointers are omitted.
type DispatchRow struct {
	DispatchID    string         `json:"dispatchId"`
	DispatchNo    string         `json:"dispatchNo"`
	PostingNumber string         `json:"postingNumber"`
	State         string         `json:"state"`
	Deadline      *string        `json:"deadline,omitempty"`
	Lines         []DispatchLine `json:"lines"`
	NudgeCount    int32          `json:"nudgeCount"`
	NudgedAtMs    *int64         `json:"nudgedAtMs,omitempty"`
	PayoutCents   *int64         `json:"payoutCents,omitempty"`
	PayoutState   *string        `json:"payoutState,omitempty"`
}

// DispatchListData is the list envelope data.
type DispatchListData struct {
	Dispatches []DispatchRow `json:"dispatches"`
	Cursor     string        `json:"cursor"`
	HasMore    bool          `json:"hasMore"`
}

// AssetLink is a detail-line download pointer. object_key is not on the wire.
type AssetLink struct {
	AssetID  string `json:"assetId"`
	FileName string `json:"fileName"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
}

// LineDetail is a detail line.
type LineDetail struct {
	OfferID  string      `json:"offerId"`
	Name     string      `json:"name"`
	Quantity int32       `json:"quantity"`
	Assets   []AssetLink `json:"assets"`
}

// LogisticsView omits fields that are not JSON strings.
type LogisticsView struct {
	Warehouse         *string `json:"warehouse,omitempty"`
	DeliveryMethod    *string `json:"deliveryMethod,omitempty"`
	DeliveryType      *string `json:"deliveryType,omitempty"`
	TplProvider       *string `json:"tplProvider,omitempty"`
	City              *string `json:"city,omitempty"`
	Region            *string `json:"region,omitempty"`
	DeliveryDateBegin *string `json:"deliveryDateBegin,omitempty"`
	DeliveryDateEnd   *string `json:"deliveryDateEnd,omitempty"`
	ShipmentDate      *string `json:"shipmentDate,omitempty"`
}

// ReceiptView is the dispatch receipt object.
type ReceiptView struct {
	TrackingNo *string `json:"trackingNo,omitempty"`
	Note       *string `json:"note,omitempty"`
	Reason     *string `json:"reason,omitempty"`
	AtMs       *int64  `json:"atMs,omitempty"`
}

// ActionsView is the projection of what the current state allows.
type ActionsView struct {
	CanAccept bool `json:"canAccept"`
	CanReject bool `json:"canReject"`
	CanShip   bool `json:"canShip"`
}

// DispatchDetail is GET one dispatch.
type DispatchDetail struct {
	DispatchID    string         `json:"dispatchId"`
	DispatchNo    string         `json:"dispatchNo"`
	PostingNumber string         `json:"postingNumber"`
	State         string         `json:"state"`
	Deadline      *string        `json:"deadline,omitempty"`
	SellerNote    string         `json:"sellerNote"`
	Logistics     *LogisticsView `json:"logistics,omitempty"`
	Lines         []LineDetail   `json:"lines"`
	Receipt       *ReceiptView   `json:"receipt,omitempty"`
	Actions       ActionsView    `json:"actions"`
	CreatedAtMs   int64          `json:"createdAtMs"`
	UpdatedAtMs   int64          `json:"updatedAtMs"`
	NudgeCount    int32          `json:"nudgeCount"`
	NudgedAtMs    *int64         `json:"nudgedAtMs,omitempty"`
	PayoutCents   *int64         `json:"payoutCents,omitempty"`
	PayoutState   *string        `json:"payoutState,omitempty"`
}

// ActionData is the accept/reject/ship body.
type ActionData struct {
	DispatchID string `json:"dispatchId"`
	State      string `json:"state"`
}

// WalletView is one factory wallet, including a zero row when none is stored.
type WalletView struct {
	SourceID          string `json:"sourceId"`
	Name              string `json:"name"`
	BalanceMicrofen   int64  `json:"balanceMicrofen"`
	HeldMicrofen      int64  `json:"heldMicrofen"`
	AvailableMicrofen int64  `json:"availableMicrofen"`
}

// WalletListData is GET /api/supplier/wallet data.
type WalletListData struct {
	Wallets []WalletView `json:"wallets"`
}

// WithdrawalView is one withdrawal. Empty optionals are omitted.
type WithdrawalView struct {
	WithdrawalID  string  `json:"withdrawalId"`
	SourceID      string  `json:"sourceId"`
	Name          string  `json:"name"`
	AmountCents   int64   `json:"amountCents"`
	Channel       string  `json:"channel"`
	Account       string  `json:"account"`
	RealName      string  `json:"realName"`
	Status        string  `json:"status"`
	Reference     *string `json:"reference,omitempty"`
	RejectReason  *string `json:"rejectReason,omitempty"`
	RequestedAtMs int64   `json:"requestedAtMs"`
	DecidedAtMs   *int64  `json:"decidedAtMs,omitempty"`
}

// WithdrawalListData is the list and the create response.
type WithdrawalListData struct {
	Withdrawals []WithdrawalView `json:"withdrawals"`
}

// DownloadGrant is the JSON asset grant.
type DownloadGrant struct {
	URL         string `json:"url"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
	Bytes       int64  `json:"bytes"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	SHA256      string `json:"sha256"`
}

// AssetBytes is the proxied object. JSON is set when Accept asked for a grant.
type AssetBytes struct {
	Grant       *DownloadGrant
	Body        []byte
	ContentType string
	FileName    string
	Inline      bool
}

// GalleryItem is one seller gallery entry.
type GalleryItem struct {
	URL string `json:"url"`
	W   int64  `json:"w"`
	H   int64  `json:"h"`
}

// VideoItem is one product video.
type VideoItem struct {
	URL        string `json:"url"`
	CoverURL   string `json:"coverUrl"`
	DurationMs int64  `json:"durationMs"`
}

// PropOption is one select option.
type PropOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// PropDef is a seller-visible property definition.
type PropDef struct {
	PropID        string       `json:"propId"`
	SourceID      string       `json:"sourceId"`
	Name          string       `json:"name"`
	Type          string       `json:"type"`
	Options       []PropOption `json:"options"`
	Position      int64        `json:"position"`
	SellerVisible bool         `json:"sellerVisible"`
	CreatedAtMs   int64        `json:"createdAtMs"`
	UpdatedAtMs   int64        `json:"updatedAtMs"`
}

// CatalogRow is one seller supplier-db row. Pointers serialize as null.
type CatalogRow struct {
	Listable               bool          `json:"listable"`
	Denial                 *string       `json:"denial,omitempty"`
	ProductID              string        `json:"productId"`
	SourceID               string        `json:"sourceId"`
	Title                  string        `json:"title"`
	PlatformCode           string        `json:"platformCode"`
	VariantGroup           string        `json:"variantGroup"`
	DescriptionCategoryID  *int64        `json:"descriptionCategoryId"`
	TypeID                 *int64        `json:"typeId"`
	PlatformPriceCents     *int64        `json:"platformPriceCents"`
	SuggestedRetailCents   *int64        `json:"suggestedRetailCents"`
	SuggestedOldPriceCents *int64        `json:"suggestedOldPriceCents"`
	ShippingCostCents      *int64        `json:"shippingCostCents"`
	LeadTime               string        `json:"leadTime"`
	Size                   string        `json:"size"`
	Material               string        `json:"material"`
	Craft                  string        `json:"craft"`
	GrossWeightG           *int64        `json:"grossWeightG"`
	Brand                  string        `json:"brand"`
	PackWidthMm            *int64        `json:"packWidthMm"`
	PackHeightMm           *int64        `json:"packHeightMm"`
	PackDepthMm            *int64        `json:"packDepthMm"`
	PackWeightG            *int64        `json:"packWeightG"`
	Contents               string        `json:"contents"`
	Gallery                []GalleryItem `json:"gallery"`
	ProductVideos          []VideoItem   `json:"productVideos"`
	FixedTags              []string      `json:"fixedTags"`
	Description            string        `json:"description"`
	Props                  Object        `json:"props"`
	ListedAtMs             int64         `json:"listedAtMs"`
}

// CatalogData is GET /api/supplier-dbs/catalog data.
type CatalogData struct {
	DBs      []SourceCard `json:"dbs"`
	PropDefs []PropDef    `json:"propDefs"`
	Rows     []CatalogRow `json:"rows"`
}

// ImageBody is a catalog thumbnail response.
type ImageBody struct {
	Bytes       []byte
	ContentType string
}
