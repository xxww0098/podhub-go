package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/store/contract"
)

// The mirror schedule. These thresholds are contract: the SPA computes the
// same freshness table for its own rows and `web/tests/fixtures/
// product-freshness.json` pins both sides.
const (
	// ReconcileIntervalMS is the cadence every store walks.
	ReconcileIntervalMS = 4 * 60 * 60 * 1000
	// ExpiredAfterMS bounds freshness even for a long period.
	ExpiredAfterMS = 3 * 24 * 60 * 60 * 1000
	// FailureExpiresAt is the streak that expires a value early.
	FailureExpiresAt = 3
	// ManualRefreshMS is the per-store 「立即更新」 interval.
	ManualRefreshMS = 10 * 60 * 1000

	// DefaultListLimit is the products page size when the caller says nothing.
	DefaultListLimit = 100
	// MaxListLimit is the largest page the keyset accepts.
	MaxListLimit = 200
	// MaxNeedle is the byte ceiling for the search string.
	MaxNeedle = 256
	// MaxOfferIDs is the largest verify batch.
	MaxOfferIDs = 1000
	// MaxOfferIDLen is the byte ceiling for one offer id.
	MaxOfferIDLen = 128
	// MaxCursor is the byte ceiling for an opaque keyset cursor.
	MaxCursor = 57
)

// Freshness is how much a mirrored value can still be trusted. `never` and
// `expired` are states, not zeroes.
type Freshness string

const (
	FreshnessFresh   Freshness = "fresh"
	FreshnessStale   Freshness = "stale"
	FreshnessExpired Freshness = "expired"
	FreshnessNever   Freshness = "never"
)

// ClassifyFreshness is freshness::classify. A nil reference is never-learned;
// three consecutive failures expire the value early; the three-day cap bounds
// "two periods" for long cadences.
func ClassifyFreshness(reference *int64, periodMS int64, failures int, nowMS int64) Freshness {
	if reference == nil {
		return FreshnessNever
	}
	if failures >= FailureExpiresAt {
		return FreshnessExpired
	}
	age := nowMS - *reference
	if age < 0 {
		age = 0
	}
	if age < 2*periodMS && age < ExpiredAfterMS {
		return FreshnessFresh
	}
	if age < ExpiredAfterMS {
		return FreshnessStale
	}
	return FreshnessExpired
}

// StoreFreshness ages a store against its reconcile commit.
func StoreFreshness(lastFullSyncAtMS *int64, failures int, nowMS int64) Freshness {
	return ClassifyFreshness(lastFullSyncAtMS, ReconcileIntervalMS, failures, nowMS)
}

// StatusFilter is the products tab. `zero_stock` is a flag on on_sale rows,
// not a sixth bucket.
type StatusFilter string

const (
	FilterOnSale           StatusFilter = "on_sale"
	FilterProcessing       StatusFilter = "processing"
	FilterHidden           StatusFilter = "hidden"
	FilterModerationFailed StatusFilter = "moderation_failed"
	FilterZeroStock        StatusFilter = "zero_stock"
	FilterArchived         StatusFilter = "archived"
	FilterDelisted         StatusFilter = "delisted"
)

// ParseStatusFilter reads the query parameter. An unknown spelling is refused
// rather than silently answered with the default tab.
func ParseStatusFilter(raw string) (StatusFilter, *contract.APIError) {
	switch StatusFilter(strings.TrimSpace(raw)) {
	case "":
		return "", nil
	case FilterOnSale, FilterProcessing, FilterHidden, FilterModerationFailed,
		FilterZeroStock, FilterArchived, FilterDelisted:
		return StatusFilter(strings.TrimSpace(raw)), nil
	}
	return "", contract.Validation(contract.MsgStatusFilter)
}

// ProductCursor is one keyset position: the last row's store and product id.
type ProductCursor struct {
	StoreUUID string
	ProductID int64
}

// ParseProductCursor reads "{uuid}:{product_id}". The length cap is checked
// before splitting so a huge string never reaches the SQL.
func ParseProductCursor(raw string) (ProductCursor, *contract.APIError) {
	if len(raw) > MaxCursor {
		return ProductCursor{}, contract.Validation(contract.MsgProductCursor)
	}
	storeRaw, productRaw, ok := strings.Cut(raw, ":")
	if !ok {
		return ProductCursor{}, contract.Validation(contract.MsgProductCursor)
	}
	store, ok := NormalizeStoreUUID(storeRaw)
	if !ok {
		return ProductCursor{}, contract.Validation(contract.MsgProductCursor)
	}
	product, err := strconv.ParseInt(productRaw, 10, 64)
	if err != nil || product <= 0 {
		return ProductCursor{}, contract.Validation(contract.MsgProductCursor)
	}
	return ProductCursor{StoreUUID: store, ProductID: product}, nil
}

// FormatProductCursor renders the cursor for the next page.
func FormatProductCursor(storeUUID string, productID int64) string {
	return storeUUID + ":" + strconv.FormatInt(productID, 10)
}

// ProductQuery is one already-normalized page request.
type ProductQuery struct {
	Status      StatusFilter
	Needle      string
	IncludeGone bool
	Cursor      *ProductCursor
	Limit       int64
}

// NormalizeProductQuery applies the limits and escapes the LIKE metacharacters.
// The escaped needle is what the truncated index searches, so a raw `%` cannot
// quietly widen the match.
func NormalizeProductQuery(status, q, cursor string, includeGone bool, limit *int64) (ProductQuery, *contract.APIError) {
	filter, api := ParseStatusFilter(status)
	if api != nil {
		return ProductQuery{}, api
	}
	if len(q) > MaxNeedle {
		return ProductQuery{}, contract.Validation(contract.MsgProductNeedle)
	}
	size := int64(DefaultListLimit)
	if limit != nil {
		size = *limit
	}
	if size < 1 || size > MaxListLimit {
		return ProductQuery{}, contract.Validation(contract.MsgProductLimit)
	}
	out := ProductQuery{Status: filter, IncludeGone: includeGone, Limit: size}
	if needle := strings.ToLower(strings.TrimSpace(q)); needle != "" {
		out.Needle = escapeLike(needle)
	}
	if cursor != "" {
		parsed, api := ParseProductCursor(cursor)
		if api != nil {
			return ProductQuery{}, api
		}
		out.Cursor = &parsed
	}
	return out, nil
}

// escapeLike literalizes `\`, `%`, and `_` for a LIKE pattern.
func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

// ScopeOf restricts a query to one already-authorized store.
func (q ProductQuery) ScopeOf(uuid string) ProductQuery {
	q.Cursor = &ProductCursor{StoreUUID: uuid}
	return q
}

// Product is one mirrored row as the read surfaces paint it.
type Product struct {
	StoreID       string
	StoreName     string
	ProductID     int64
	OfferID       string
	Name          *string
	SKU           *int64
	ImageURL      *string
	StatusName    *string
	State         *string
	ModelID       *int64
	ModelCount    *int64
	Price         *string
	OldPrice      *string
	StockPresent  *int32
	StockReserved *int32
	Gone          bool
	RefreshedAtMS *int64
	Metrics       *ProductMetrics
}

// ProductMetrics is one SKU's funnel snapshot. Nil means Ozon reported
// nothing in the window — never render it as zero.
type ProductMetrics struct {
	HitsView        *float64
	SessionView     *float64
	HitsTocart      *float64
	ConvTocart      *float64
	OrderedUnits    *float64
	Revenue         *float64
	RevenueCurrency string
	FxQuote         *string
	FxRate          *float64
	FxAsOf          *string
	FxSource        *string
	PeriodDays      int64
	ThroughDay      string
	FetchedAtMS     int64
}

// ProductPage is one keyset page.
type ProductPage struct {
	Rows       []Product
	NextCursor *string
}

// OverviewStore is one store's mirror position on the overview screen.
type OverviewStore struct {
	StoreID               string
	Name                  string
	Status                string
	AssigneeName          *string
	Pass                  *string
	Hold                  *string
	HoldReason            *string
	HoldUntilMS           *int64
	LastFullSyncAtMS      *int64
	NextDueAtMS           *int64
	ManualRequestedAtMS   *int64
	ManualNextAllowedAtMS *int64
	MetricsAtMS           *int64
	MetricsError          *string
	Currency              *string
	Counts                *ProductCounts
	Freshness             Freshness
}

// ProductCounts is the whole-or-nothing summary a finished full sync writes.
// All eight arrive together or not at all.
type ProductCounts struct {
	Total            int64
	OnSale           int64
	Processing       int64
	Hidden           int64
	ModerationFailed int64
	ZeroStock        int64
	Archived         int64
	Delisted         int64
}

// ProductOverview is the whole overview screen.
type ProductOverview struct {
	Stores         []OverviewStore
	Totals         ProductCounts
	CoverageRead   int64
	CoverageTotal  int64
	NewestSyncAtMS *int64
	SyncDisabled   bool
}

// BuildOverview folds per-store sync rows into the overview. Only fresh and
// stale stores feed the totals; expired and never-synced ones move the
// coverage denominator only, because their numbers are not facts any more.
func BuildOverview(stores []OverviewStore, nowMS int64, syncDisabled bool) ProductOverview {
	out := ProductOverview{
		Stores:        make([]OverviewStore, 0, len(stores)),
		CoverageTotal: int64(len(stores)),
		SyncDisabled:  syncDisabled,
	}
	for _, store := range stores {
		store.Freshness = StoreFreshness(store.LastFullSyncAtMS, 0, nowMS)
		if store.Counts != nil && (store.Freshness == FreshnessFresh || store.Freshness == FreshnessStale) {
			out.Totals.add(*store.Counts)
			out.CoverageRead++
		}
		if store.LastFullSyncAtMS != nil {
			if out.NewestSyncAtMS == nil || *store.LastFullSyncAtMS > *out.NewestSyncAtMS {
				value := *store.LastFullSyncAtMS
				out.NewestSyncAtMS = &value
			}
		}
		out.Stores = append(out.Stores, store)
	}
	return out
}

func (c *ProductCounts) add(other ProductCounts) {
	c.Total += other.Total
	c.OnSale += other.OnSale
	c.Processing += other.Processing
	c.Hidden += other.Hidden
	c.ModerationFailed += other.ModerationFailed
	c.ZeroStock += other.ZeroStock
	c.Archived += other.Archived
	c.Delisted += other.Delisted
}

// SyncPress is what one 「立即更新」 decided.
type SyncPress struct {
	Generation            int64
	Attached              bool
	ManualNextAllowedAtMS int64
}

// PlanManualPress is manual::accept_manual_press's decision, pure. The caller
// has already established the interval and the in-flight facts.
//
// pass is the live generation's phase; inflight and pending describe a walk
// this store already has. Any of them means the press attaches rather than
// queues a second walk.
func PlanManualPress(pass string, generation, manualRequestedAtMS *int64, inflight, pending bool, nowMS int64) (SyncPress, bool, int64) {
	if manualRequestedAtMS != nil && nowMS-*manualRequestedAtMS < ManualRefreshMS {
		return SyncPress{}, true, *manualRequestedAtMS + ManualRefreshMS
	}
	reported := int64(1)
	if generation != nil && *generation > 0 {
		reported = *generation
	}
	attached := pass != "" && pass != "none" || inflight || pending
	return SyncPress{
		Generation:            reported,
		Attached:              attached,
		ManualNextAllowedAtMS: nowMS + ManualRefreshMS,
	}, false, 0
}

// NormalizeOfferIDs trims, drops blanks, and checks the verify batch.
func NormalizeOfferIDs(raw []string) ([]string, *contract.APIError) {
	out := make([]string, 0, len(raw))
	for _, id := range raw {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if len(trimmed) > MaxOfferIDLen {
			return nil, contract.Validation(contract.MsgOfferIDsLong)
		}
		out = append(out, trimmed)
	}
	if len(out) == 0 || len(out) > MaxOfferIDs {
		return nil, contract.Validation(contract.MsgOfferIDs)
	}
	return out, nil
}

// VerifyDigest is sha256 over the sorted batch: "same batch" is a set, not an
// order, so a retry that reorders its ids still dedups.
func VerifyDigest(offerIDs []string) string {
	sorted := append([]string(nil), offerIDs...)
	sort.Strings(sorted)
	sum := sha256.New()
	for _, id := range sorted {
		sum.Write([]byte(id))
		sum.Write([]byte{0})
	}
	return hex.EncodeToString(sum.Sum(nil))
}

// StoreImageURL is the products list's `imageUrl`. An allowlisted Ozon CDN URL
// becomes the same-origin thumbnail route; any other https URL is the URL Ozon
// reported, loaded directly. Anything else (empty, relative, http) is dropped
// so the row shows its placeholder.
func StoreImageURL(storeUUID string, productID int64, raw *string) *string {
	if raw == nil {
		return nil
	}
	class, canonical := ClassifyImage(*raw)
	switch class {
	case ImageDirect:
		return &canonical
	case ImageProxy:
		sum := sha256.Sum256([]byte(canonical))
		stamp := hex.EncodeToString(sum[:8])
		url := "/api/workspaces/stores/" + storeUUID + "/products/" +
			strconv.FormatInt(productID, 10) + "/thumbnail?v=" + stamp
		return &url
	}
	return nil
}

// ImageClass is how one stored primary_image may be served.
type ImageClass int

const (
	// ImageDrop means the value is not a usable image URL.
	ImageDrop ImageClass = iota
	// ImageDirect means the browser loads it itself.
	ImageDirect
	// ImageProxy means this process may fetch and re-serve the bytes.
	ImageProxy
)

// ClassifyImage decides whether a stored URL may be fetched by this process.
// Only Ozon CDN hosts are proxied: a seller can put an arbitrary URL on a
// product before Ozon copies it to the CDN.
func ClassifyImage(raw string) (ImageClass, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ImageDrop, ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return ImageDrop, ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ImageDrop, ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return ImageDrop, ""
	}
	if OzonImageHost(host) {
		if parsed.Port() != "" && parsed.Port() != "80" && parsed.Port() != "443" {
			return ImageDrop, ""
		}
		parsed.Scheme = "https"
		parsed.Host = host
		parsed.Fragment = ""
		return ImageProxy, parsed.String()
	}
	if parsed.Scheme != "https" {
		return ImageDrop, ""
	}
	return ImageDirect, parsed.String()
}

// OzonImageHost reports an Ozon image host. An IP literal never matches, and
// neither does a non-ASCII name.
func OzonImageHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "" || net.ParseIP(host) != nil {
		return false
	}
	for _, r := range host {
		if r > 127 {
			return false
		}
	}
	for _, root := range []string{"ozone.ru", "ozon.ru"} {
		if host == root || strings.HasSuffix(host, "."+root) {
			return true
		}
	}
	return false
}

// NextImageHop resolves one thumbnail redirect and keeps it on an Ozon CDN.
func NextImageHop(current, location string) (string, bool) {
	base, err := url.Parse(current)
	if err != nil {
		return "", false
	}
	next, err := base.Parse(strings.TrimSpace(location))
	if err != nil || next.User != nil {
		return "", false
	}
	if next.Scheme != "https" || next.Port() != "" || !OzonImageHost(next.Hostname()) {
		return "", false
	}
	return next.String(), true
}

// SniffImage returns a raster content type, or "" when the bytes are not one.
func SniffImage(body []byte) string {
	switch {
	case len(body) >= 3 && body[0] == 0xFF && body[1] == 0xD8 && body[2] == 0xFF:
		return "image/jpeg"
	case len(body) >= 8 && string(body[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(body) >= 6 && (string(body[:6]) == "GIF87a" || string(body[:6]) == "GIF89a"):
		return "image/gif"
	case len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}
