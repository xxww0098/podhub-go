package storehttp

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The products mirror routes.
const (
	// PathProducts is the workspace-wide product list.
	PathProducts = "/api/workspaces/products"
	// PathProductsOverview is one row per visible store with its sync state.
	PathProductsOverview = "/api/workspaces/products/overview"
	// PathProductSync is 「立即更新」 for one store.
	PathProductSync = "/api/workspaces/stores/{uuid}/products/sync"
	// PathProductVerify spends one Seller read on a batch of offer ids.
	PathProductVerify = "/api/workspaces/stores/{uuid}/products/verify"
	// PathThumbnail re-serves one mirrored image on the app origin.
	PathThumbnail = "/api/workspaces/stores/{uuid}/products/{product_id}/thumbnail"
)

// Thumbnail budget. The list rewrites allowlisted Ozon CDN URLs to this path,
// so a page of 100 rows can ask for 100 images at once.
const (
	maxImageBytes  = 4 * 1024 * 1024
	maxRedirects   = 3
	thumbnailWait  = 200 * 1e6 // 200 ms
	thumbnailSlots = 16
)

// ProductActions is the products half of the store service.
type ProductActions interface {
	Products(ctx context.Context, orgID, userID int64, storeID, status, q, cursor string, includeGone bool, limit *int64) (domain.ProductPage, *contract.APIError)
	ProductsOverview(ctx context.Context, orgID, userID int64) (domain.ProductOverview, *contract.APIError)
	SyncNow(ctx context.Context, orgID, userID int64, uuid string) (domain.SyncPress, *contract.APIError)
	Verify(ctx context.Context, orgID, userID int64, uuid string, offerIDs []string) ([]domain.Product, *contract.APIError)
	ThumbnailSource(ctx context.Context, orgID int64, uuid string, productID int64) (string, *contract.APIError)
}

type productRowView struct {
	StoreID       string             `json:"store_id"`
	StoreName     string             `json:"store_name"`
	ProductID     int64              `json:"product_id"`
	OfferID       string             `json:"offer_id"`
	Name          *string            `json:"name,omitempty"`
	SKU           *int64             `json:"sku,omitempty"`
	ImageURL      *string            `json:"image_url,omitempty"`
	StatusName    *string            `json:"status_name,omitempty"`
	State         *string            `json:"state,omitempty"`
	ModelID       *int64             `json:"model_id,omitempty"`
	ModelCount    *int64             `json:"model_count,omitempty"`
	Price         *string            `json:"price,omitempty"`
	OldPrice      *string            `json:"old_price,omitempty"`
	StockPresent  *int32             `json:"stock_present,omitempty"`
	StockReserved *int32             `json:"stock_reserved,omitempty"`
	Gone          bool               `json:"gone"`
	RefreshedAtMS *int64             `json:"refreshed_at_ms,omitempty"`
	Metrics       *productMetricView `json:"metrics,omitempty"`
}

type productMetricView struct {
	HitsView        *float64 `json:"hits_view"`
	SessionView     *float64 `json:"session_view"`
	HitsTocart      *float64 `json:"hits_tocart"`
	ConvTocart      *float64 `json:"conv_tocart"`
	OrderedUnits    *float64 `json:"ordered_units"`
	Revenue         *float64 `json:"revenue"`
	RevenueCurrency string   `json:"revenue_currency"`
	FxQuote         *string  `json:"fx_quote,omitempty"`
	FxRate          *float64 `json:"fx_rate,omitempty"`
	FxAsOf          *string  `json:"fx_as_of,omitempty"`
	FxSource        *string  `json:"fx_source,omitempty"`
	PeriodDays      int64    `json:"period_days"`
	ThroughDay      string   `json:"through_day"`
	FetchedAtMS     int64    `json:"fetched_at_ms"`
}

type productsListData struct {
	Rows       []productRowView `json:"rows"`
	NextCursor *string          `json:"next_cursor,omitempty"`
}

type productCountsView struct {
	Total            int64 `json:"total"`
	OnSale           int64 `json:"on_sale"`
	Processing       int64 `json:"processing"`
	Hidden           int64 `json:"hidden"`
	ModerationFailed int64 `json:"moderation_failed"`
	ZeroStock        int64 `json:"zero_stock"`
	Archived         int64 `json:"archived"`
	Delisted         int64 `json:"delisted"`
}

type productOverviewRowView struct {
	StoreID               string           `json:"store_id"`
	Name                  string           `json:"name"`
	Status                string           `json:"status"`
	AssigneeName          *string          `json:"assignee_name,omitempty"`
	Pass                  *string          `json:"pass,omitempty"`
	Hold                  *string          `json:"hold,omitempty"`
	HoldReason            *string          `json:"hold_reason,omitempty"`
	HoldUntilMS           *int64           `json:"hold_until_ms,omitempty"`
	LastFullSyncAtMS      *int64           `json:"last_full_sync_at_ms,omitempty"`
	NextDueAtMS           *int64           `json:"next_due_at_ms,omitempty"`
	ManualRequestedAtMS   *int64           `json:"manual_requested_at_ms,omitempty"`
	ManualNextAllowedAtMS *int64           `json:"manual_next_allowed_at_ms,omitempty"`
	MetricsAtMS           *int64           `json:"metrics_at_ms,omitempty"`
	MetricsError          *string          `json:"metrics_error,omitempty"`
	Currency              *string          `json:"currency,omitempty"`
	CountTotal            *int64           `json:"count_total,omitempty"`
	CountOnSale           *int64           `json:"count_on_sale,omitempty"`
	CountProcessing       *int64           `json:"count_processing,omitempty"`
	CountHidden           *int64           `json:"count_hidden,omitempty"`
	CountModerationFailed *int64           `json:"count_moderation_failed,omitempty"`
	CountZeroStock        *int64           `json:"count_zero_stock,omitempty"`
	CountArchived         *int64           `json:"count_archived,omitempty"`
	CountDelisted         *int64           `json:"count_delisted,omitempty"`
	Freshness             domain.Freshness `json:"freshness"`
}

type productsOverviewData struct {
	Stores         []productOverviewRowView `json:"stores"`
	Totals         productCountsView        `json:"totals"`
	Coverage       coverageView             `json:"coverage"`
	NewestSyncAtMS *int64                   `json:"newest_sync_at_ms,omitempty"`
	SyncDisabled   bool                     `json:"sync_disabled"`
}

type coverageView struct {
	Read  int64 `json:"read"`
	Total int64 `json:"total"`
}

type syncNowData struct {
	Generation            int64 `json:"generation"`
	ManualNextAllowedAtMS int64 `json:"manual_next_allowed_at_ms"`
	Attached              bool  `json:"attached"`
}

type verifyRequest struct {
	OfferIDs []string `json:"offer_ids"`
}

type verifyData struct {
	Rows []productRowView `json:"rows"`
}

// listProducts is GET PathProducts.
func (h handler) listProducts(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	var limit *int64
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeAPIError(w, contract.Validation(contract.MsgProductLimit))
			return
		}
		limit = &parsed
	}
	includeGone := false
	if raw := strings.TrimSpace(query.Get("includeGone")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
			return
		}
		includeGone = parsed
	}
	page, api := h.Products.Products(r.Context(), p.OrgID, p.UserID,
		query.Get("storeId"), query.Get("status"), query.Get("q"), query.Get("cursor"), includeGone, limit)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, productsListData{
		Rows: toProductRows(page.Rows), NextCursor: page.NextCursor,
	})
}

// productsOverview is GET PathProductsOverview.
func (h handler) productsOverview(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	overview, api := h.Products.ProductsOverview(r.Context(), p.OrgID, p.UserID)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, toOverview(overview))
}

// syncProducts is POST PathProductSync. It answers 202: the work happens on a
// worker, and the page already shows the generation this press produced.
func (h handler) syncProducts(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	press, api := h.Products.SyncNow(r.Context(), p.OrgID, p.UserID, uuid)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusAccepted, syncNowData{
		Generation: press.Generation, ManualNextAllowedAtMS: press.ManualNextAllowedAtMS,
		Attached: press.Attached,
	})
}

// verifyProducts is POST PathProductVerify.
func (h handler) verifyProducts(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	var body verifyRequest
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	rows, api := h.Products.Verify(r.Context(), p.OrgID, p.UserID, uuid, body.OfferIDs)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, verifyData{Rows: toProductRows(rows)})
}

// thumbnail is GET PathThumbnail. It fetches an allowlisted Ozon CDN URL and
// re-serves the bytes on the app origin. It is not a Seller call: no kill
// switch, no budget, no governor.
func (h handler) thumbnail(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := domain.NormalizeStoreUUID(chi.URLParam(r, "uuid"))
	if !ok {
		writeAPIError(w, contract.NotFound(contract.MsgProductStoreMiss))
		return
	}
	productID, err := strconv.ParseInt(chi.URLParam(r, "product_id"), 10, 64)
	if err != nil || productID <= 0 {
		writeAPIError(w, contract.NotFound(contract.MsgProductMissing))
		return
	}
	if !h.visibleStore(r, p, uuid) {
		writeAPIError(w, contract.NotFound(contract.MsgProductStoreMiss))
		return
	}
	images, api := h.Products.ThumbnailSource(r.Context(), p.OrgID, uuid, productID)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	if images == "" {
		writeAPIError(w, contract.NotFound(contract.MsgProductMissing))
		return
	}
	class, canonical := domain.ClassifyImage(images)
	if class != domain.ImageProxy {
		writeAPIError(w, contract.NotFound(contract.MsgProductMissing))
		return
	}
	h.serveImage(w, r, canonical)
}

// visibleStore asks the roster whether the caller can see this store. It is
// the same predicate the list routes use, so a hidden store is a 404 here too.
func (h handler) visibleStore(r *http.Request, p Session, uuid string) bool {
	roster, _, api := h.Refresh.Roster(r.Context(), p.OrgID, p.UserID)
	if api != nil {
		return false
	}
	for _, row := range roster.Stores {
		if row.UUID == uuid {
			return true
		}
	}
	return false
}

// serveImage fetches one allowlisted URL inside a bounded budget and writes the
// bytes. Redirects stay on the Ozon CDN; a hop that leaves it is refused.
func (h handler) serveImage(w http.ResponseWriter, r *http.Request, target string) {
	client := httpx.RestrictedClient()
	ctx, cancel := context.WithTimeout(r.Context(), 8e9)
	defer cancel()
	current := target
	for hop := 0; hop <= maxRedirects; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current, nil)
		if err != nil {
			writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
			return
		}
		req.Header.Set("User-Agent", "podhub-thumbnail")
		resp, err := client.Do(req)
		if err != nil {
			writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
			return
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_ = resp.Body.Close()
			next, ok := domain.NextImageHop(current, location)
			if !ok || hop == maxRedirects {
				writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
				return
			}
			current = next
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			_ = resp.Body.Close()
			writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
			return
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
		_ = resp.Body.Close()
		if err != nil || len(raw) > maxImageBytes {
			writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
			return
		}
		contentType := domain.SniffImage(raw)
		if contentType == "" {
			writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}
	writeAPIError(w, contract.Unreachable(contract.MsgImageUnavailable))
}

// toProductRows renders the wire shape. A nil metrics object stays absent: the
// row never learned what Ozon sold, which is not the same as zero.
func toProductRows(rows []domain.Product) []productRowView {
	out := make([]productRowView, 0, len(rows))
	for _, row := range rows {
		view := productRowView{
			StoreID: row.StoreID, StoreName: row.StoreName, ProductID: row.ProductID,
			OfferID: row.OfferID, Name: row.Name, SKU: row.SKU, ImageURL: row.ImageURL,
			StatusName: row.StatusName, State: row.State, ModelID: row.ModelID,
			ModelCount: row.ModelCount, Price: row.Price, OldPrice: row.OldPrice,
			StockPresent: row.StockPresent, StockReserved: row.StockReserved,
			Gone: row.Gone, RefreshedAtMS: row.RefreshedAtMS,
		}
		if row.Metrics != nil {
			view.Metrics = &productMetricView{
				HitsView: row.Metrics.HitsView, SessionView: row.Metrics.SessionView,
				HitsTocart: row.Metrics.HitsTocart, ConvTocart: row.Metrics.ConvTocart,
				OrderedUnits: row.Metrics.OrderedUnits, Revenue: row.Metrics.Revenue,
				RevenueCurrency: row.Metrics.RevenueCurrency, FxQuote: row.Metrics.FxQuote,
				FxRate: row.Metrics.FxRate, FxAsOf: row.Metrics.FxAsOf,
				FxSource: row.Metrics.FxSource, PeriodDays: row.Metrics.PeriodDays,
				ThroughDay: row.Metrics.ThroughDay, FetchedAtMS: row.Metrics.FetchedAtMS,
			}
		}
		out = append(out, view)
	}
	return out
}

// toOverview renders the overview screen. Counts are present together or
// absent together, so one nil check settles the whole group.
func toOverview(overview domain.ProductOverview) productsOverviewData {
	out := productsOverviewData{
		Stores: make([]productOverviewRowView, 0, len(overview.Stores)),
		Totals: productCountsView{
			Total: overview.Totals.Total, OnSale: overview.Totals.OnSale,
			Processing: overview.Totals.Processing, Hidden: overview.Totals.Hidden,
			ModerationFailed: overview.Totals.ModerationFailed,
			ZeroStock:        overview.Totals.ZeroStock, Archived: overview.Totals.Archived,
			Delisted: overview.Totals.Delisted,
		},
		Coverage:       coverageView{Read: overview.CoverageRead, Total: overview.CoverageTotal},
		NewestSyncAtMS: overview.NewestSyncAtMS,
		SyncDisabled:   overview.SyncDisabled,
	}
	for _, store := range overview.Stores {
		view := productOverviewRowView{
			StoreID: store.StoreID, Name: store.Name, Status: store.Status,
			AssigneeName: store.AssigneeName, Pass: store.Pass, Hold: store.Hold,
			HoldReason: store.HoldReason, HoldUntilMS: store.HoldUntilMS,
			LastFullSyncAtMS: store.LastFullSyncAtMS, NextDueAtMS: store.NextDueAtMS,
			ManualRequestedAtMS:   store.ManualRequestedAtMS,
			ManualNextAllowedAtMS: store.ManualNextAllowedAtMS,
			MetricsAtMS:           store.MetricsAtMS, MetricsError: store.MetricsError,
			Currency: store.Currency, Freshness: store.Freshness,
		}
		if counts := store.Counts; counts != nil {
			view.CountTotal = &counts.Total
			view.CountOnSale = &counts.OnSale
			view.CountProcessing = &counts.Processing
			view.CountHidden = &counts.Hidden
			view.CountModerationFailed = &counts.ModerationFailed
			view.CountZeroStock = &counts.ZeroStock
			view.CountArchived = &counts.Archived
			view.CountDelisted = &counts.Delisted
		}
		out.Stores = append(out.Stores, view)
	}
	return out
}
