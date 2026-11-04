package observerepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	observecontract "github.com/xxww0098/podhub-go/internal/admin/observe/contract"
	"github.com/xxww0098/podhub-go/internal/admin/observe/domain"
	"github.com/xxww0098/podhub-go/internal/platform/uuidx"
)

type rawProduct struct {
	orgID int64
	item  productItem
	image string
}

type overviewStore struct {
	StoreID               string  `json:"store_id"`
	Name                  string  `json:"name"`
	Status                string  `json:"status"`
	AssigneeName          *string `json:"assignee_name"`
	Pass                  *string `json:"pass"`
	Hold                  *string `json:"hold"`
	LastFullSyncAtMS      *int64  `json:"last_full_sync_at_ms"`
	NextDueAtMS           *int64  `json:"next_due_at_ms"`
	ManualRequestedAtMS   *int64  `json:"manual_requested_at_ms"`
	ManualNextAllowedAtMS *int64  `json:"manual_next_allowed_at_ms"`
	HoldUntilMS           *int64  `json:"hold_until_ms"`
	HoldReason            *string `json:"hold_reason"`
	CountTotal            *int64  `json:"count_total"`
	CountOnSale           *int64  `json:"count_on_sale"`
	CountProcessing       *int64  `json:"count_processing"`
	CountHidden           *int64  `json:"count_hidden"`
	CountModerationFailed *int64  `json:"count_moderation_failed"`
	CountZeroStock        *int64  `json:"count_zero_stock"`
	CountArchived         *int64  `json:"count_archived"`
	CountDelisted         *int64  `json:"count_delisted"`
	MetricsAtMS           *int64  `json:"metrics_at_ms"`
	MetricsError          *string `json:"metrics_error"`
	Currency              *string `json:"currency"`
	Freshness             string  `json:"freshness"`
}

type countTotals struct {
	Total            int64 `json:"total"`
	OnSale           int64 `json:"on_sale"`
	Processing       int64 `json:"processing"`
	Hidden           int64 `json:"hidden"`
	ModerationFailed int64 `json:"moderation_failed"`
	ZeroStock        int64 `json:"zero_stock"`
	Archived         int64 `json:"archived"`
	Delisted         int64 `json:"delisted"`
}

func (r *Observe) Overview(ctx context.Context, actor corecontract.Actor, scope observecontract.Scope) ([]byte, error) {
	scope, err := normalizeScope(scope)
	if err != nil {
		return nil, err
	}
	tx, err := r.beginObserve(ctx, actor)
	if err != nil {
		return nil, corerepo.MapBill(err, "internal", true)
	}
	workspaces, stores, _, err := loadScope(ctx, tx, scope)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", true)
	}
	syncs, err := loadSync(ctx, tx, storeIDs(stores))
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", true)
	}
	if err := r.finishObserve(ctx, tx, actor, scope); err != nil {
		return nil, corerepo.MapBill(err, "internal", true)
	}
	byID := map[string]syncRow{}
	for _, row := range syncs {
		byID[row.StoreID] = row
	}
	now := r.now().UnixMilli()
	views := make([]overviewStore, 0, len(stores))
	var totals countTotals
	var read int
	var newest *int64
	for _, store := range stores {
		row := byID[store.StoreID]
		freshness := domain.StoreFreshness(row.LastFull, row.Failures, now)
		currency := row.Currency
		if currency != nil && len([]rune(*currency)) >= 0 && trimEmpty(*currency) {
			currency = nil
		}
		views = append(views, overviewStore{
			StoreID: store.StoreID, Name: store.StoreName, Status: domain.StoreStatus(store.Manual, store.Quota),
			AssigneeName: store.Assignee, Pass: row.Pass, Hold: row.Hold, LastFullSyncAtMS: row.LastFull,
			NextDueAtMS: row.NextDue, ManualRequestedAtMS: row.ManualRequested, ManualNextAllowedAtMS: domain.ManualNext(row.ManualRequested),
			HoldUntilMS: row.HoldUntil, HoldReason: row.HoldReason, CountTotal: row.CountTotal, CountOnSale: row.CountOnSale,
			CountProcessing: row.CountProcessing, CountHidden: row.CountHidden, CountModerationFailed: row.CountModeration,
			CountZeroStock: row.CountZero, CountArchived: row.CountArchived, CountDelisted: row.CountDelisted,
			MetricsAtMS: row.MetricsAt, MetricsError: row.MetricsError, Currency: currency, Freshness: freshness,
		})
		counts := []*int64{row.CountTotal, row.CountOnSale, row.CountProcessing, row.CountHidden, row.CountModeration, row.CountZero, row.CountArchived, row.CountDelisted}
		if domain.CountsReadable(freshness, counts) {
			read++
			totals.Total += *row.CountTotal
			totals.OnSale += *row.CountOnSale
			totals.Processing += *row.CountProcessing
			totals.Hidden += *row.CountHidden
			totals.ModerationFailed += *row.CountModeration
			totals.ZeroStock += *row.CountZero
			totals.Archived += *row.CountArchived
			totals.Delisted += *row.CountDelisted
		}
		if row.LastFull != nil && (newest == nil || *row.LastFull > *newest) {
			newest = row.LastFull
		}
	}
	if err := r.auditObserve(ctx, actor, scopeOrg(workspaces, scope), entityOf(scope), "/api/admin/stores/products/overview", "observation_products_overview", scope, len(workspaces), len(stores), len(views)); err != nil {
		return nil, corerepo.MapBill(err, "internal", true)
	}
	return corerepo.Data(struct {
		Stores   []overviewStore `json:"stores"`
		Totals   countTotals     `json:"totals"`
		Coverage struct {
			Read  int `json:"read"`
			Total int `json:"total"`
		} `json:"coverage"`
		NewestSyncAtMS *int64 `json:"newest_sync_at_ms"`
		SyncDisabled   bool   `json:"sync_disabled"`
	}{Stores: views, Totals: totals, Coverage: struct {
		Read  int `json:"read"`
		Total int `json:"total"`
	}{read, len(stores)}, NewestSyncAtMS: newest, SyncDisabled: true})
}

func trimEmpty(value string) bool {
	for _, r := range value {
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}

type productMetrics struct {
	HitsView        *int64   `json:"hits_view"`
	SessionView     *int64   `json:"session_view"`
	HitsTocart      *int64   `json:"hits_tocart"`
	ConvTocart      *float64 `json:"conv_tocart"`
	OrderedUnits    *int64   `json:"ordered_units"`
	Revenue         *float64 `json:"revenue"`
	RevenueCurrency string   `json:"revenue_currency"`
	FxQuote         *string  `json:"fx_quote"`
	FxRate          *float64 `json:"fx_rate"`
	FxAsOf          *string  `json:"fx_as_of"`
	FxSource        *string  `json:"fx_source"`
	PeriodDays      *int32   `json:"period_days"`
	ThroughDay      *string  `json:"through_day"`
	FetchedAtMS     *int64   `json:"fetched_at_ms"`
}

type productItem struct {
	WorkspaceID   string     `json:"workspace_id"`
	WorkspaceName string     `json:"workspace_name"`
	OwnerUUID     string     `json:"owner_uuid"`
	OwnerName     string     `json:"owner_name"`
	Product       productRow `json:"product"`
}

type productRow struct {
	StoreID       string          `json:"store_id"`
	StoreName     string          `json:"store_name"`
	ProductID     int64           `json:"product_id"`
	OfferID       string          `json:"offer_id"`
	Name          *string         `json:"name"`
	SKU           *string         `json:"sku"`
	ImageURL      *string         `json:"image_url,omitempty"`
	ImageRetired  bool            `json:"image_retired,omitempty"`
	StatusName    *string         `json:"status_name"`
	State         *string         `json:"state"`
	ModelID       *int64          `json:"model_id"`
	ModelCount    *int64          `json:"model_count"`
	Price         *string         `json:"price"`
	OldPrice      *string         `json:"old_price"`
	StockPresent  *int64          `json:"stock_present"`
	StockReserved *int64          `json:"stock_reserved"`
	Metrics       *productMetrics `json:"metrics,omitempty"`
	Gone          bool            `json:"gone"`
	RefreshedAtMS *int64          `json:"refreshed_at_ms"`
}

func (r *Observe) Products(ctx context.Context, actor corecontract.Actor, query observecontract.ProductQuery) ([]byte, error) {
	scope, err := normalizeScope(query.Scope)
	if err != nil {
		return nil, err
	}
	query.Scope = scope
	predicate, ok := domain.StatusPredicate(query.Status)
	if !ok {
		return nil, corecontract.Validation("validation", "查询参数无效")
	}
	needle, fault := domain.LikeNeedle(query.Q)
	if fault != nil {
		return nil, fault
	}
	limit, fault := domain.ProductLimit(query.Limit)
	if fault != nil {
		return nil, fault
	}
	tx, err := r.beginObserve(ctx, actor)
	if err != nil {
		return nil, corerepo.MapBill(err, "internal", true)
	}
	workspaces, stores, _, err := loadScope(ctx, tx, scope)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", true)
	}
	names := map[string]obsStore{}
	for _, store := range stores {
		names[store.StoreID] = store
	}
	var cursorStore any
	var cursorProduct int64
	if query.Cursor != "" {
		store, product, fault := domain.ParseCursor(query.Cursor, func(id string) bool {
			_, ok := names[id]
			return ok
		})
		if fault != nil {
			_ = tx.Rollback(ctx)
			return nil, fault
		}
		cursorStore = store
		cursorProduct = product
	}
	gone := "p.gone_at_ms IS NULL"
	if query.IncludeGone || query.Status == "delisted" {
		gone = "true"
	}
	var needleArg any
	if needle != "" {
		needleArg = needle
	}
	sql := fmt.Sprintf(`
		SELECT p.org_id, s.uuid::text, p.product_id, p.offer_id, p.name, CASE WHEN p.sku > 0 THEN p.sku::text END, COALESCE(p.primary_image, ''),
		       d.status_name, d.state, p.model_id, p.model_count, p.price::text, p.old_price::text,
		       p.stock_present, p.stock_reserved, (p.gone_at_ms IS NOT NULL), p.refreshed_at_ms,
		       m.hits_view, m.session_view, m.hits_tocart, m.conv_tocart, m.ordered_units, m.revenue,
		       m.fx_quote, m.fx_rate, to_char(m.fx_as_of, 'YYYY-MM-DD'), m.fx_source, m.period_days,
		       to_char(m.through_day, 'YYYY-MM-DD'), m.fetched_at_ms
		  FROM store_products p
		  JOIN organization_stores s ON s.id = p.store_pk AND s.org_id = p.org_id
		  JOIN ozon_product_status d ON d.id = p.status_id
		  LEFT JOIN store_product_metrics m ON m.store_pk = p.store_pk AND m.org_id = p.org_id AND m.sku = p.sku
		  JOIN organizations o ON o.id = s.org_id
		 WHERE s.uuid = ANY($1::uuid[])
		   AND s.deleted_at_ms IS NULL AND o.dissolved_at IS NULL
		   AND %s AND %s
		   AND ($3::text IS NULL OR lower(p.offer_id || ' ' || COALESCE(p.name, '')) LIKE '%%' || $3 || '%%' ESCAPE '\')
		   AND ($4::uuid IS NULL OR (s.uuid, p.product_id) > ($4::uuid, $5))
		 ORDER BY s.uuid, p.product_id
		 LIMIT $2`, predicate, gone)
	rows, err := tx.Query(ctx, sql, storeIDs(stores), limit+1, needleArg, cursorStore, cursorProduct)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", true)
	}
	raws := []rawProduct{}
	for rows.Next() {
		var raw rawProduct
		var metrics productMetrics
		var hits *int64
		err := rows.Scan(&raw.orgID, &raw.item.Product.StoreID, &raw.item.Product.ProductID, &raw.item.Product.OfferID,
			&raw.item.Product.Name, &raw.item.Product.SKU, &raw.image, &raw.item.Product.StatusName, &raw.item.Product.State,
			&raw.item.Product.ModelID, &raw.item.Product.ModelCount, &raw.item.Product.Price, &raw.item.Product.OldPrice,
			&raw.item.Product.StockPresent, &raw.item.Product.StockReserved, &raw.item.Product.Gone, &raw.item.Product.RefreshedAtMS,
			&hits, &metrics.SessionView, &metrics.HitsTocart, &metrics.ConvTocart, &metrics.OrderedUnits, &metrics.Revenue,
			&metrics.FxQuote, &metrics.FxRate, &metrics.FxAsOf, &metrics.FxSource, &metrics.PeriodDays, &metrics.ThroughDay, &metrics.FetchedAtMS)
		if err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return nil, corerepo.MapBill(err, "internal", true)
		}
		metrics.HitsView = hits
		if hits != nil || metrics.FetchedAtMS != nil {
			metrics.RevenueCurrency = "RUB"
			raw.item.Product.Metrics = &metrics
		}
		store, ok := names[raw.item.Product.StoreID]
		if !ok {
			rows.Close()
			_ = tx.Rollback(ctx)
			return nil, corecontract.NotFound("not_found", "观察范围不存在")
		}
		raw.item.WorkspaceID = store.WorkspaceID
		raw.item.WorkspaceName = store.WorkspaceName
		raw.item.OwnerUUID = store.OwnerUUID
		raw.item.OwnerName = store.OwnerName
		raw.item.Product.StoreName = store.StoreName
		raws = append(raws, raw)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", true)
	}
	rows.Close()
	var next *string
	if int64(len(raws)) > limit {
		raws = raws[:limit]
		last := raws[len(raws)-1]
		text := fmt.Sprintf("%s:%d", last.item.Product.StoreID, last.item.Product.ProductID)
		next = &text
	}
	retired, err := retiredImages(ctx, tx, raws)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, corerepo.MapBill(err, "internal", true)
	}
	if err := r.finishObserve(ctx, tx, actor, scope); err != nil {
		return nil, corerepo.MapBill(err, "internal", true)
	}
	items := make([]productItem, 0, len(raws))
	for i, raw := range raws {
		if retired[i] {
			raw.item.Product.ImageRetired = true
		} else if url, ok := domain.AdminImageURL(raw.item.Product.StoreID, raw.item.Product.ProductID, raw.image); ok {
			raw.item.Product.ImageURL = &url
		}
		items = append(items, raw.item)
	}
	if err := r.auditObserve(ctx, actor, scopeOrg(workspaces, scope), entityOf(scope), "/api/admin/stores/products", "observation_products", scope, len(workspaces), len(stores), len(items)); err != nil {
		return nil, corerepo.MapBill(err, "internal", true)
	}
	return corerepo.Data(struct {
		Items      []productItem `json:"items"`
		NextCursor *string       `json:"next_cursor,omitempty"`
	}{items, next})
}

func retiredImages(ctx context.Context, tx pgx.Tx, raws []rawProduct) (map[int]bool, error) {
	out := map[int]bool{}
	orgs := make([]int64, 0, len(raws))
	images := make([]string, 0, len(raws))
	for _, raw := range raws {
		orgs = append(orgs, raw.orgID)
		images = append(images, raw.image)
	}
	if len(images) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT input.ordinal::bigint, lease.object_key, lease.public_url
		  FROM unnest($1::bigint[], $2::text[]) WITH ORDINALITY AS input(org_id, primary_image, ordinal)
		 CROSS JOIN LATERAL public.media_reference_candidates(input.primary_image) candidate
		  JOIN public.organizations owner ON owner.id = input.org_id
		  JOIN public.media_object_leases lease
		    ON public.media_gc_image_identity(lease.object_key) = candidate.workspace_uuid::text || ':' || candidate.content_hash
		   AND lease.org_id = input.org_id AND lease.workspace_uuid = owner.uuid
		 WHERE lease.retired_at IS NOT NULL AND public.is_media_gc_image_key(lease.object_key)`, orgs, images)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ordinal int64
		var key, publicURL string
		if err := rows.Scan(&ordinal, &key, &publicURL); err != nil {
			return nil, err
		}
		index := int(ordinal - 1)
		if index < 0 || index >= len(raws) {
			continue
		}
		image := raws[index].image
		if image == key || image == publicURL {
			out[index] = true
		}
	}
	return out, rows.Err()
}

func (r *Observe) Thumbnail(ctx context.Context, actor corecontract.Actor, thumb observecontract.Thumbnail) (observecontract.ImageBytes, error) {
	storeID, ok := uuidx.StrictUUID(thumb.StoreID)
	if !ok {
		return observecontract.ImageBytes{}, corecontract.Validation("validation", "范围 UUID 无效")
	}
	productID, err := strconvParse(thumb.ProductID)
	if err != nil || productID <= 0 {
		return observecontract.ImageBytes{}, corecontract.NotFound("not_found", "观察范围不存在")
	}
	tx, err := r.beginObserve(ctx, actor)
	if err != nil {
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	scope := observecontract.Scope{StoreID: storeID}
	workspaces, stores, _, err := loadScope(ctx, tx, scope)
	if err != nil {
		_ = tx.Rollback(ctx)
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	var image string
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(p.primary_image, '') FROM store_products p
		  JOIN organization_stores s ON s.id = p.store_pk AND s.org_id = p.org_id
		  JOIN organizations o ON o.id = s.org_id
		 WHERE s.uuid = $1::uuid AND p.product_id = $2
		   AND s.deleted_at_ms IS NULL AND o.dissolved_at IS NULL`, storeID, productID).Scan(&image)
	if err != nil {
		_ = tx.Rollback(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return observecontract.ImageBytes{}, corecontract.NotFound("not_found", "观察范围不存在")
		}
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	if err := r.finishObserve(ctx, tx, actor, scope); err != nil {
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	class, canonical := domain.ClassifyImage(image)
	if class != domain.ImageProxy || canonical == "" {
		return observecontract.ImageBytes{}, corecontract.NotFound("not_found", "商品不存在")
	}
	fetch := r.Fetch
	if fetch == nil {
		fetch = LoopbackFetch
	}
	status, body, err := fetch(ctx, canonical)
	if err != nil || status < 200 || status >= 300 {
		return observecontract.ImageBytes{}, corecontract.Upstream("internal", "商品图片暂时无法读取")
	}
	kind := domain.SniffImage(body)
	if kind == "" || len(body) > 4*1024*1024 {
		return observecontract.ImageBytes{}, corecontract.Upstream("internal", "商品图片暂时无法读取")
	}
	tx, err = r.beginObserve(ctx, actor)
	if err != nil {
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	if err := r.finishObserve(ctx, tx, actor, scope); err != nil {
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	if err := r.auditObserve(ctx, actor, scopeOrg(workspaces, scope), entityOf(scope),
		"/api/admin/stores/{store_id}/products/{store_product_id}/thumbnail", "observation_thumbnail", scope, len(workspaces), len(stores), 1); err != nil {
		return observecontract.ImageBytes{}, corerepo.MapBill(err, "internal", false)
	}
	return observecontract.ImageBytes{Type: kind, Body: body}, nil
}

func strconvParse(raw string) (int64, error) {
	var n int64
	if raw == "" {
		return 0, errors.New("parse")
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, errors.New("parse")
		}
		n = n*10 + int64(c-'0')
	}
	return n, nil
}
