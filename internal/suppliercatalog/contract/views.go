package contract

import "encoding/json"

// GalleryItem is one gallery image.
type GalleryItem struct {
	URL string `json:"url"`
	W   int64  `json:"w"`
	H   int64  `json:"h"`
}

// FileItem is one PSD/source file.
type FileItem struct {
	URL   string `json:"url"`
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

// VideoItem is one product video.
type VideoItem struct {
	URL        string `json:"url"`
	CoverURL   string `json:"coverUrl"`
	DurationMS int64  `json:"durationMs"`
}

// PropOption is one select option.
type PropOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// PropDef is one property definition of the source. Managers read these to
// fill props but never change them.
type PropDef struct {
	PropID        string       `json:"propId"`
	SourceID      string       `json:"sourceId"`
	Name          string       `json:"name"`
	Type          string       `json:"type"`
	Options       []PropOption `json:"options"`
	Position      int64        `json:"position"`
	SellerVisible bool         `json:"sellerVisible"`
	CreatedAtMS   int64        `json:"createdAtMs"`
	UpdatedAtMS   int64        `json:"updatedAtMs"`
}

// RowReadiness is the publish checklist. It is the same five gates the staff
// surface enforces: a manager cannot publish a row that is not fully prepared,
// even though the prompt and Ozon config arms are staff-owned.
type RowReadiness struct {
	Category      bool `json:"category"`
	Prompt        bool `json:"prompt"`
	FixedTags     bool `json:"fixedTags"`
	PlatformPrice bool `json:"platformPrice"`
	OzonConfig    bool `json:"ozonConfig"`
}

// MissingKeys lists the false readiness keys in declaration order.
func MissingKeys(r RowReadiness) []string {
	out := []string{}
	if !r.Category {
		out = append(out, "category")
	}
	if !r.Prompt {
		out = append(out, "prompt")
	}
	if !r.FixedTags {
		out = append(out, "fixedTags")
	}
	if !r.PlatformPrice {
		out = append(out, "platformPrice")
	}
	if !r.OzonConfig {
		out = append(out, "ozonConfig")
	}
	return out
}

// Ready reports whether every publish gate is satisfied.
func (r RowReadiness) Ready() bool { return len(MissingKeys(r)) == 0 }

// CatalogRow is one row as a catalog manager sees it.
//
// costCents and shippingCostCents ARE present: doc 8.2 makes the manager one of
// the three authorised readers of sc_source_offers (alongside staff and the
// workspace's own settlement), and 8.3's parenthetical says the cost he entered
// is his to see. The reason to hide it from sellers and anonymous callers is
// that cost plus platform price reveals the margin; the manager already sets the
// cost, so showing it back leaks nothing he does not own.
//
// platformPriceCents is read-only here; only /api/admin/* may change it.
type CatalogRow struct {
	ProductID              string                     `json:"productId"`
	SKUID                  string                     `json:"skuId"`
	SourceID               string                     `json:"sourceId"`
	Title                  string                     `json:"title"`
	PlatformCode           string                     `json:"platformCode"`
	VariantGroup           string                     `json:"variantGroup"`
	DescriptionCategoryID  *int64                     `json:"descriptionCategoryId"`
	TypeID                 *int64                     `json:"typeId"`
	Published              bool                       `json:"published"`
	Archived               bool                       `json:"archived"`
	Readiness              RowReadiness               `json:"readiness"`
	CostCents              *int64                     `json:"costCents"`
	ShippingCostCents      *int64                     `json:"shippingCostCents"`
	PlatformPriceCents     *int64                     `json:"platformPriceCents"`
	SuggestedRetailCents   *int64                     `json:"suggestedRetailCents"`
	SuggestedOldPriceCents *int64                     `json:"suggestedOldPriceCents"`
	LeadTime               string                     `json:"leadTime"`
	Size                   string                     `json:"size"`
	Material               string                     `json:"material"`
	Craft                  string                     `json:"craft"`
	GrossWeightG           *int64                     `json:"grossWeightG"`
	Brand                  string                     `json:"brand"`
	PackWidthMM            *int64                     `json:"packWidthMm"`
	PackHeightMM           *int64                     `json:"packHeightMm"`
	PackDepthMM            *int64                     `json:"packDepthMm"`
	PackWeightG            *int64                     `json:"packWeightG"`
	Contents               string                     `json:"contents"`
	Gallery                []GalleryItem              `json:"gallery"`
	PSD                    []FileItem                 `json:"psd"`
	ProductVideos          []VideoItem                `json:"productVideos"`
	Description            string                     `json:"description"`
	InternalNote           string                     `json:"internalNote"`
	Props                  map[string]json.RawMessage `json:"props"`
	Revision               int64                      `json:"revision"`
	CreatedAtMS            int64                      `json:"createdAtMs"`
	UpdatedAtMS            int64                      `json:"updatedAtMs"`
}

// EmptyRowSlices replaces nil slices and maps so JSON writes [] and {}.
func (r *CatalogRow) EmptyRowSlices() {
	if r.Gallery == nil {
		r.Gallery = []GalleryItem{}
	}
	if r.PSD == nil {
		r.PSD = []FileItem{}
	}
	if r.ProductVideos == nil {
		r.ProductVideos = []VideoItem{}
	}
	if r.Props == nil {
		r.Props = map[string]json.RawMessage{}
	}
}

// SourceSummary is one source the caller manages. Source-level switches
// (listed, acceptsDelegate) are read-only here: only /api/admin/* may flip them.
type SourceSummary struct {
	SourceID        string `json:"sourceId"`
	Name            string `json:"name"`
	Country         string `json:"country"`
	Contact         string `json:"contact"`
	InternalNote    string `json:"internalNote"`
	Listed          bool   `json:"listed"`
	Icon            string `json:"icon"`
	AcceptsDelegate bool   `json:"acceptsDelegate"`
	RowCount        int64  `json:"rowCount"`
	PublishedCount  int64  `json:"publishedCount"`
	CreatedAtMS     int64  `json:"createdAtMs"`
	UpdatedAtMS     int64  `json:"updatedAtMs"`
}

// SourceListData is GET /api/supplier-catalog/sources.
type SourceListData struct {
	Sources []SourceSummary `json:"sources"`
}

// RowListData is GET /api/supplier-catalog/sources/{source_id}/rows.
type RowListData struct {
	Rows []CatalogRow `json:"rows"`
}

// SourceDetail is GET /api/supplier-catalog/sources/{source_id}.
type SourceDetail struct {
	Source   SourceSummary `json:"source"`
	PropDefs []PropDef     `json:"propDefs"`
	Rows     []CatalogRow  `json:"rows"`
}

// RowInput is one writable row.
//
// costCents and shippingCostCents are accepted here but deliberately absent
// from CatalogRow: the manager may set the supply cost without reading back the
// platform's margin (doc 8.3). The asymmetry is the rule, not an oversight.
type RowInput struct {
	Title                 string
	PlatformCode          string
	VariantGroup          string
	DescriptionCategoryID *int64
	TypeID                *int64
	SuggestedRetail       *int64
	SuggestedOld          *int64
	CostCents             *int64
	ShippingCents         *int64
	LeadTime              string
	Size                  string
	Material              string
	Craft                 string
	GrossWeightG          *int64
	Brand                 string
	PackWidthMM           *int64
	PackHeightMM          *int64
	PackDepthMM           *int64
	PackWeightG           *int64
	Contents              string
	Gallery               json.RawMessage
	PSD                   json.RawMessage
	Videos                json.RawMessage
	Description           string
	InternalNote          string
	Props                 json.RawMessage
	ExpectedRevision      *int64
	Archived              bool
}
