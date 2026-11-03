package contract

// SourceCard is one factory the signed-in member can see.
type SourceCard struct {
	SourceID string `json:"source_id"`
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
	OfferID  string `json:"offer_id"`
	Name     string `json:"name"`
	Quantity int32  `json:"quantity"`
}

// DispatchRow is one page entry. Nil pointers are omitted.
type DispatchRow struct {
	DispatchID    string         `json:"dispatch_id"`
	DispatchNo    string         `json:"dispatch_no"`
	PostingNumber string         `json:"posting_number"`
	State         string         `json:"state"`
	Deadline      *string        `json:"deadline,omitempty"`
	Lines         []DispatchLine `json:"lines"`
	ThumbnailURL  *string        `json:"thumbnail_url,omitempty"`
	NudgeCount    int32          `json:"nudge_count"`
	NudgedAtMs    *int64         `json:"nudged_at_ms,omitempty"`
	PayoutCents   *int64         `json:"payout_cents,omitempty"`
	PayoutState   *string        `json:"payout_state,omitempty"`
}

// DispatchListData is the list envelope data.
type DispatchListData struct {
	Dispatches []DispatchRow `json:"dispatches"`
	Cursor     string        `json:"cursor"`
	HasMore    bool          `json:"has_more"`
}

type DashboardCounts struct {
	Pending   int64 `json:"pending"`
	Producing int64 `json:"producing"`
	Urgent    int64 `json:"urgent"`
	Shipped   int64 `json:"shipped"`
}

type DashboardData struct {
	Counts       DashboardCounts `json:"counts"`
	UrgentOrders []DispatchRow   `json:"urgent_orders"`
}

// AssetLink is a detail-line download pointer. object_key is not on the wire.
type AssetLink struct {
	AssetID  string `json:"asset_id"`
	FileName string `json:"file_name"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
}

// LineDetail is a detail line.
type LineDetail struct {
	OfferID  string      `json:"offer_id"`
	Name     string      `json:"name"`
	Quantity int32       `json:"quantity"`
	Assets   []AssetLink `json:"assets"`
}

// LogisticsView omits fields that are not JSON strings.
type LogisticsView struct {
	Warehouse         *string `json:"warehouse,omitempty"`
	DeliveryMethod    *string `json:"delivery_method,omitempty"`
	DeliveryType      *string `json:"delivery_type,omitempty"`
	TplProvider       *string `json:"tpl_provider,omitempty"`
	City              *string `json:"city,omitempty"`
	Region            *string `json:"region,omitempty"`
	DeliveryDateBegin *string `json:"delivery_date_begin,omitempty"`
	DeliveryDateEnd   *string `json:"delivery_date_end,omitempty"`
	ShipmentDate      *string `json:"shipment_date,omitempty"`
}

// ReceiptView is the dispatch receipt object.
type ReceiptView struct {
	TrackingNo *string `json:"tracking_no,omitempty"`
	Note       *string `json:"note,omitempty"`
	Reason     *string `json:"reason,omitempty"`
	AtMs       *int64  `json:"at_ms,omitempty"`
}

// ActionsView is the projection of what the current state allows.
type ActionsView struct {
	CanAccept bool `json:"can_accept"`
	CanReject bool `json:"can_reject"`
	CanShip   bool `json:"can_ship"`
}

// DispatchDetail is GET one dispatch.
type DispatchDetail struct {
	DispatchID    string         `json:"dispatch_id"`
	DispatchNo    string         `json:"dispatch_no"`
	PostingNumber string         `json:"posting_number"`
	State         string         `json:"state"`
	Deadline      *string        `json:"deadline,omitempty"`
	SellerNote    string         `json:"seller_note"`
	Logistics     *LogisticsView `json:"logistics,omitempty"`
	Lines         []LineDetail   `json:"lines"`
	Receipt       *ReceiptView   `json:"receipt,omitempty"`
	Actions       ActionsView    `json:"actions"`
	CreatedAtMs   int64          `json:"created_at_ms"`
	UpdatedAtMs   int64          `json:"updated_at_ms"`
	NudgeCount    int32          `json:"nudge_count"`
	NudgedAtMs    *int64         `json:"nudged_at_ms,omitempty"`
	PayoutCents   *int64         `json:"payout_cents,omitempty"`
	PayoutState   *string        `json:"payout_state,omitempty"`
}

// ActionData is the accept/reject/ship body.
type ActionData struct {
	DispatchID string `json:"dispatch_id"`
	State      string `json:"state"`
}

// DownloadGrant is the JSON asset grant.
type DownloadGrant struct {
	URL         string `json:"url"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
	Bytes       int64  `json:"bytes"`
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	SHA256      string `json:"sha256"`
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
