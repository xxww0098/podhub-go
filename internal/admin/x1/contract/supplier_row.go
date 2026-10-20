package contract

import "encoding/json"

const (
	catalogStaleMS = int64(24 * 60 * 60 * 1000)
	catalogMaxMS   = int64(72 * 60 * 60 * 1000)
)

// RowReadiness is SupplierDbReadiness, in declaration order.
type RowReadiness struct {
	Category      bool `json:"category"`
	Prompt        bool `json:"prompt"`
	FixedTags     bool `json:"fixedTags"`
	PlatformPrice bool `json:"platformPrice"`
	OzonConfig    bool `json:"ozonConfig"`
}

// GalleryItem is url, w, h.
type GalleryItem struct {
	URL string `json:"url"`
	W   int64  `json:"w"`
	H   int64  `json:"h"`
}

// FileItem is url, name, bytes.
type FileItem struct {
	URL   string `json:"url"`
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

// VideoItem is url, coverUrl, durationMs.
type VideoItem struct {
	URL        string `json:"url"`
	CoverURL   string `json:"coverUrl"`
	DurationMS int64  `json:"durationMs"`
}

// RowData is SupplierDbRowData. Omitted options use omitempty.
// Null money and category ids are pointers without omitempty.
type RowData struct {
	ProductID             string                     `json:"productId"`
	SKU                   string                     `json:"skuId"`
	SourceID              string                     `json:"sourceId"`
	Title                 string                     `json:"title"`
	PlatformCode          string                     `json:"platformCode"`
	VariantGroup          string                     `json:"variantGroup"`
	DescriptionCategoryID *int64                     `json:"descriptionCategoryId"`
	TypeID                *int64                     `json:"typeId"`
	Published             bool                       `json:"published"`
	Archived              bool                       `json:"archived"`
	Readiness             RowReadiness               `json:"readiness"`
	Denial                string                     `json:"denial,omitempty"`
	OzonConfigDenial      string                     `json:"ozonConfigDenial,omitempty"`
	CostCents             *int64                     `json:"costCents"`
	ShippingCostCents     *int64                     `json:"shippingCostCents"`
	PlatformPriceCents    *int64                     `json:"platformPriceCents"`
	SuggestedRetailCents  *int64                     `json:"suggestedRetailCents"`
	SuggestedOldPrice     *int64                     `json:"suggestedOldPriceCents"`
	LeadTime              string                     `json:"leadTime"`
	Size                  string                     `json:"size"`
	Material              string                     `json:"material"`
	Craft                 string                     `json:"craft"`
	GrossWeightG          *int64                     `json:"grossWeightG"`
	Brand                 string                     `json:"brand"`
	PackWidthMM           *int64                     `json:"packWidthMm"`
	PackHeightMM          *int64                     `json:"packHeightMm"`
	PackDepthMM           *int64                     `json:"packDepthMm"`
	PackWeightG           *int64                     `json:"packWeightG"`
	Contents              string                     `json:"contents"`
	Gallery               []GalleryItem              `json:"gallery"`
	PSD                   []FileItem                 `json:"psd"`
	ProductVideos         []VideoItem                `json:"productVideos"`
	PromptName            string                     `json:"promptName"`
	PromptFileName        string                     `json:"promptFileName"`
	PromptContent         string                     `json:"promptContent"`
	FixedTags             []string                   `json:"fixedTags"`
	DraftPromptRevision   *int32                     `json:"draftPromptRevision,omitempty"`
	PublishedPromptRev    *int32                     `json:"publishedPromptRevision,omitempty"`
	Description           string                     `json:"description"`
	InternalNote          string                     `json:"internalNote"`
	Props                 map[string]json.RawMessage `json:"props"`
	Revision              int64                      `json:"revision"`
	CreatedAtMS           int64                      `json:"createdAtMs"`
	UpdatedAtMS           int64                      `json:"updatedAtMs"`
	CreatedBy             string                     `json:"createdBy"`
	CreatorName           *string                    `json:"creatorName,omitempty"`
}

// DbDetail is SupplierDbDetailData.
type DbDetail struct {
	DB       SupplierDb `json:"db"`
	PropDefs []Prop     `json:"propDefs"`
	Rows     []RowData  `json:"rows"`
}

// RowFacts are the inputs of readiness and the two denials.
type RowFacts struct {
	SourceListed     bool
	Archived         bool
	SKUPublished     bool
	CategoryID       *int64
	TypeID           *int64
	PublishedPrompt  string
	PublishedTags    []string
	PlatformPrice    *int64
	ConfigState      *string
	ValidatedDigest  *string
	CurrentDigest    *string
	CatalogFetchedAt *int64
	NowMS            int64
}

// Freshness matches catalog_freshness. A missing fetched_at is fresh.
func Freshness(fetched, now int64, present bool) string {
	if !present {
		return "fresh"
	}
	age := now - fetched
	if fetched > now {
		age = 0
	}
	if age > catalogMaxMS {
		return "expired"
	}
	if age > catalogStaleMS {
		return "stale"
	}
	return "fresh"
}

func (f RowFacts) configState() string {
	if f.ConfigState == nil {
		return "needs_reconfiguration"
	}
	switch *f.ConfigState {
	case "valid", "needs_reconfiguration":
		return *f.ConfigState
	default:
		return "needs_reconfiguration"
	}
}

func (f RowFacts) fresh() string {
	if f.CatalogFetchedAt == nil {
		return "fresh"
	}
	return Freshness(*f.CatalogFetchedAt, f.NowMS, true)
}

// ProductDenial is product_listability. Empty means the key is omitted.
func (f RowFacts) ProductDenial() string {
	return denial(f.SourceListed, f.Archived, f.SKUPublished, BriefValid(f.PublishedPrompt), f)
}

// ConfigDenial forces source, archive, sku and prompt to pass, then the same predicate.
func (f RowFacts) ConfigDenial() string {
	return denial(true, false, true, true, f)
}

func denial(listed, archived, sku, prompt bool, f RowFacts) string {
	switch {
	case !listed:
		return "source_not_listed"
	case archived:
		return "product_archived"
	case !sku:
		return "sku_not_published"
	case f.fresh() == "expired":
		return "catalog_expired"
	case f.CurrentDigest == nil || *f.CurrentDigest == "":
		return "catalog_missing"
	case f.configState() != "valid":
		return "config_needs_reconfiguration"
	case !sameDigest(f.ValidatedDigest, f.CurrentDigest):
		return "catalog_digest_mismatch"
	case !prompt:
		return "prompt_invalid"
	default:
		return ""
	}
}

func sameDigest(a, b *string) bool {
	if a == nil || b == nil || *a == "" || *b == "" {
		return a != nil && b != nil && *a != "" && *a == *b
	}
	return *a == *b
}

// FillReadiness writes readiness from the published cells.
func (r *RowData) FillReadiness(f RowFacts) {
	configDenial := f.ConfigDenial()
	ozonOK := configDenial != "catalog_missing" && configDenial != "catalog_expired" &&
		configDenial != "config_needs_reconfiguration" && configDenial != "catalog_digest_mismatch"
	r.Readiness = RowReadiness{
		Category:      f.CategoryID != nil && f.TypeID != nil,
		Prompt:        BriefValid(f.PublishedPrompt),
		FixedTags:     FixedTags(f.PublishedTags) == nil,
		PlatformPrice: f.PlatformPrice != nil,
		OzonConfig:    ozonOK,
	}
	r.Denial = f.ProductDenial()
	r.OzonConfigDenial = configDenial
}

// MissingKeys lists the false readiness keys, in declaration order.
func MissingKeys(r RowReadiness) []string {
	var out []string
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
	if out == nil {
		out = []string{}
	}
	return out
}

// EmptyRowSlices replaces nil slices and maps so JSON writes [] and {}.
func (r *RowData) EmptyRowSlices() {
	if r.Gallery == nil {
		r.Gallery = []GalleryItem{}
	}
	if r.PSD == nil {
		r.PSD = []FileItem{}
	}
	if r.ProductVideos == nil {
		r.ProductVideos = []VideoItem{}
	}
	if r.FixedTags == nil {
		r.FixedTags = []string{}
	}
	if r.Props == nil {
		r.Props = map[string]json.RawMessage{}
	}
}
