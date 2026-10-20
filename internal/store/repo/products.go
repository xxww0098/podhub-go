package storerepo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// productColumns is the one product projection. Every read selects these, so a
// new mirror column is added once.
const productColumns = `
	s.uuid::text AS store_id, p.product_id, p.offer_id, p.name, p.sku,
	p.primary_image, d.status_name, d.state, p.model_id, p.model_count,
	p.price::text AS price, p.old_price::text AS old_price,
	p.stock_present, p.stock_reserved,
	(p.gone_at_ms IS NOT NULL) AS gone, p.refreshed_at_ms,
	m.hits_view, m.session_view, m.hits_tocart, m.conv_tocart,
	m.ordered_units, m.revenue, m.fx_quote, m.fx_rate,
	to_char(m.fx_as_of, 'YYYY-MM-DD') AS fx_as_of, m.fx_source,
	m.period_days, to_char(m.through_day, 'YYYY-MM-DD') AS through_day,
	m.fetched_at_ms`

// productJoins is the FROM clause those columns assume: the store, the status
// dictionary, and the funnel snapshot (left, because most rows have none).
const productJoins = `
	  FROM public.store_products p
	  JOIN public.organization_stores s ON s.id = p.store_pk AND s.org_id = p.org_id
	  JOIN public.ozon_product_status d ON d.id = p.status_id
	  LEFT JOIN public.store_product_metrics m
	         ON m.store_pk = p.store_pk AND m.org_id = p.org_id AND m.sku = p.sku`

// statusPredicate is the tab's one classification. It reads the dictionary's
// `state`, never a LIKE over status texts.
func statusPredicate(filter domain.StatusFilter) string {
	switch filter {
	// 「所有」 excludes archived rows: archives live only on their own tab.
	case "":
		return "d.state != 'archived'"
	case domain.FilterOnSale:
		return "d.state = 'on_sale'"
	case domain.FilterProcessing:
		return "d.state = 'processing'"
	case domain.FilterHidden:
		return "d.state = 'hidden'"
	case domain.FilterModerationFailed:
		return "d.state = 'moderation_failed'"
	// An orthogonal flag on on_sale rows, not a fifth bucket.
	case domain.FilterZeroStock:
		return "(d.state = 'on_sale' AND p.stock_present = 0)"
	case domain.FilterArchived:
		return "d.state = 'archived'"
	case domain.FilterDelisted:
		return "p.gone_at_ms IS NOT NULL"
	}
	return "d.state != 'archived'"
}

// gonePredicate keeps soft-deleted rows out unless the caller asked for them.
// The delisted tab is already selecting gone rows, so it implies the flag.
func gonePredicate(query domain.ProductQuery) string {
	if query.IncludeGone || query.Status == domain.FilterDelisted {
		return "true"
	}
	return "p.gone_at_ms IS NULL"
}

// ListProducts reads one keyset page for the caller's already-authorized
// store set. The scope is applied here rather than by the caller so a cursor
// can never widen it: a cursor naming a store outside the set is refused.
func (r Repo) ListProducts(ctx context.Context, orgID int64, scope []domain.Row, query domain.ProductQuery) (domain.ProductPage, *contract.APIError) {
	if len(scope) == 0 {
		return domain.ProductPage{Rows: []domain.Product{}}, nil
	}
	names := make(map[string]string, len(scope))
	ids := make([]string, 0, len(scope))
	for _, row := range scope {
		names[row.UUID] = row.Name
		ids = append(ids, row.UUID)
	}
	if query.Cursor != nil && !containsString(ids, query.Cursor.StoreUUID) {
		return domain.ProductPage{}, contract.Validation(contract.MsgProductScope)
	}
	var cursorStore any
	var cursorProduct int64
	if query.Cursor != nil {
		cursorStore = query.Cursor.StoreUUID
		cursorProduct = query.Cursor.ProductID
	}
	var needle any
	if query.Needle != "" {
		needle = query.Needle
	}
	var out []domain.Product
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+productColumns+productJoins+`
			 WHERE s.uuid = ANY($1::uuid[])
			   AND s.deleted_at_ms IS NULL
			   AND `+statusPredicate(query.Status)+`
			   AND `+gonePredicate(query)+`
			   AND ($3::text IS NULL
			        OR lower(p.offer_id || ' ' || COALESCE(p.name, ''))
			           LIKE '%' || $3 || '%' ESCAPE '\')
			   AND ($4::uuid IS NULL OR (s.uuid, p.product_id) > ($4::uuid, $5))
			 ORDER BY s.uuid, p.product_id
			 LIMIT $2`,
			ids, query.Limit+1, needle, cursorStore, cursorProduct)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			product, err := scanProduct(rows)
			if err != nil {
				return err
			}
			out = append(out, product)
		}
		return rows.Err()
	})
	if err != nil {
		return domain.ProductPage{}, asAPIError(err, contract.MsgUnavailable)
	}
	page := domain.ProductPage{Rows: make([]domain.Product, 0, len(out))}
	if int64(len(out)) > query.Limit {
		last := out[query.Limit-1]
		cursor := domain.FormatProductCursor(last.StoreID, last.ProductID)
		page.NextCursor = &cursor
		out = out[:query.Limit]
	}
	// The store name comes from the roster the caller already authorized; the
	// projection does not join the stores table a second time for it.
	for _, product := range out {
		product.StoreName = names[product.StoreID]
		page.Rows = append(page.Rows, product)
	}
	return page, nil
}

// MirrorProducts reads the mirror rows for one store and offer-id batch, the
// shape the verify route answers with. Ties are broken toward the live, most
// recently read row: an offer id can be shared after an Ozon-side rename, and
// identity is product_id.
func (r Repo) MirrorProducts(ctx context.Context, orgID int64, storeUUID string, offerIDs []string) ([]domain.Product, *contract.APIError) {
	var out []domain.Product
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, apiErr := mirrorProductsTx(ctx, tx, orgID, storeUUID, offerIDs)
		out = rows
		if apiErr != nil {
			return apiErr
		}
		return nil
	})
	if err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}

// mirrorProductsTx is the transaction-bound form the verify land phase uses.
func mirrorProductsTx(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, offerIDs []string) ([]domain.Product, *contract.APIError) {
	var out []domain.Product
	{
		rows, err := tx.Query(ctx, `
			SELECT `+productColumns+`
			  FROM public.store_products p
			  JOIN public.organization_stores s ON s.id = p.store_pk AND s.org_id = p.org_id
			  JOIN public.ozon_product_status d ON d.id = p.status_id
			  LEFT JOIN public.store_product_metrics m
			         ON m.store_pk = p.store_pk AND m.org_id = p.org_id AND m.sku = p.sku
			 WHERE p.org_id = $1 AND s.uuid = $2::uuid AND p.offer_id = ANY($3)
			 ORDER BY (p.gone_at_ms IS NOT NULL), p.refreshed_at_ms DESC NULLS LAST, p.product_id`,
			orgID, storeUUID, offerIDs)
		if err != nil {
			return nil, asAPIError(err, contract.MsgUnavailable)
		}
		defer rows.Close()
		for rows.Next() {
			product, err := scanProduct(rows)
			if err != nil {
				return nil, asAPIError(err, contract.MsgUnavailable)
			}
			out = append(out, product)
		}
		if err := rows.Err(); err != nil {
			return nil, asAPIError(err, contract.MsgUnavailable)
		}
	}
	return out, nil
}

func scanProduct(row pgx.Row) (domain.Product, error) {
	var out domain.Product
	var metrics domain.ProductMetrics
	var metricsAt *int64
	var periodDays *int16
	var throughDay *string
	err := row.Scan(
		&out.StoreID, &out.ProductID, &out.OfferID, &out.Name, &out.SKU,
		&out.ImageURL, &out.StatusName, &out.State, &out.ModelID, &out.ModelCount,
		&out.Price, &out.OldPrice, &out.StockPresent, &out.StockReserved,
		&out.Gone, &out.RefreshedAtMS,
		&metrics.HitsView, &metrics.SessionView, &metrics.HitsTocart, &metrics.ConvTocart,
		&metrics.OrderedUnits, &metrics.Revenue, &metrics.FxQuote, &metrics.FxRate,
		&metrics.FxAsOf, &metrics.FxSource, &periodDays, &throughDay, &metricsAt)
	if err != nil {
		return domain.Product{}, err
	}
	out.ImageURL = domain.StoreImageURL(out.StoreID, out.ProductID, out.ImageURL)
	// `fetched_at_ms` is NOT NULL on a landed row, so its presence is what
	// says the whole metrics shape is known.
	if metricsAt != nil {
		metrics.FetchedAtMS = *metricsAt
		metrics.RevenueCurrency = "RUB"
		if periodDays != nil {
			metrics.PeriodDays = int64(*periodDays)
		}
		if throughDay != nil {
			metrics.ThroughDay = *throughDay
		}
		out.Metrics = &metrics
	}
	return out, nil
}

// syncRow is one store_product_sync row the overview reads.
type syncRow struct {
	StoreID               string
	Pass                  *string
	Hold                  *string
	HoldReason            *string
	HoldUntilMS           *int64
	LastFullSyncAtMS      *int64
	NextDueAtMS           *int64
	ManualRequestedAtMS   *int64
	MetricsAtMS           *int64
	MetricsError          *string
	Currency              *string
	ConsecutiveFailures   int
	Counts                *domain.ProductCounts
	RefreshGeneration     int64
	InflightUntilMS       *int64
	VerifyAtMS            *int64
	VerifyDigest          *string
	CallsDay              *string
	CallsManual           int
	PriceStockEverySixHrs bool
}

// LoadOverview reads every visible store's mirror position in one transaction.
// The store list comes from the roster, so visibility is decided once.
func (r Repo) LoadOverview(ctx context.Context, orgID int64, rows []domain.Row, nowMS int64, syncDisabled bool) (domain.ProductOverview, *contract.APIError) {
	stores := make([]domain.OverviewStore, 0, len(rows))
	byID := make(map[string]domain.Row, len(rows))
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.UUID)
		byID[row.UUID] = row
		stores = append(stores, domain.OverviewStore{
			StoreID: row.UUID,
			Name:    row.Name,
			Status:  string(row.Status()),
		})
	}
	if len(ids) == 0 {
		return domain.BuildOverview(stores, nowMS, syncDisabled), nil
	}
	syncs := make(map[string]syncRow, len(ids))
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		result, err := tx.Query(ctx, `
			SELECT s.uuid::text, sync.pass, sync.hold, sync.hold_reason, sync.hold_until_ms,
			       sync.last_full_sync_at_ms, sync.next_due_at_ms, sync.manual_requested_at_ms,
			       sync.consecutive_failures, sync.metrics_at_ms, sync.metrics_error,
			       sync.currency, sync.count_total, sync.count_on_sale, sync.count_processing,
			       sync.count_hidden, sync.count_moderation_failed, sync.count_zero_stock,
			       sync.count_archived, sync.count_delisted, sync.refresh_generation,
			       sync.inflight_until_ms
			  FROM public.store_product_sync sync
			  JOIN public.organization_stores s ON s.uuid = sync.store_id AND s.org_id = sync.org_id
			 WHERE sync.store_id = ANY($1::uuid[]) AND s.deleted_at_ms IS NULL`, ids)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var row syncRow
			var total, onSale, processing, hidden, moderationFailed, zeroStock, archived, delisted *int64
			if err := result.Scan(&row.StoreID, &row.Pass, &row.Hold, &row.HoldReason, &row.HoldUntilMS,
				&row.LastFullSyncAtMS, &row.NextDueAtMS, &row.ManualRequestedAtMS,
				&row.ConsecutiveFailures, &row.MetricsAtMS, &row.MetricsError,
				&row.Currency, &total, &onSale, &processing,
				&hidden, &moderationFailed, &zeroStock, &archived, &delisted,
				&row.RefreshGeneration, &row.InflightUntilMS); err != nil {
				return err
			}
			// The count columns are written whole or not at all, so one
			// present value settles the question for all eight.
			if total != nil && onSale != nil && processing != nil && hidden != nil &&
				moderationFailed != nil && zeroStock != nil && archived != nil && delisted != nil {
				row.Counts = &domain.ProductCounts{
					Total: *total, OnSale: *onSale, Processing: *processing, Hidden: *hidden,
					ModerationFailed: *moderationFailed, ZeroStock: *zeroStock,
					Archived: *archived, Delisted: *delisted,
				}
			}
			syncs[row.StoreID] = row
		}
		return result.Err()
	})
	if err != nil {
		return domain.ProductOverview{}, asAPIError(err, contract.MsgUnavailable)
	}
	for i := range stores {
		row, ok := syncs[stores[i].StoreID]
		if !ok {
			continue
		}
		stores[i].Pass = row.Pass
		stores[i].Hold = row.Hold
		stores[i].HoldReason = row.HoldReason
		stores[i].HoldUntilMS = row.HoldUntilMS
		stores[i].LastFullSyncAtMS = row.LastFullSyncAtMS
		stores[i].NextDueAtMS = row.NextDueAtMS
		stores[i].ManualRequestedAtMS = row.ManualRequestedAtMS
		if row.ManualRequestedAtMS != nil {
			next := *row.ManualRequestedAtMS + domain.ManualRefreshMS
			stores[i].ManualNextAllowedAtMS = &next
		}
		stores[i].MetricsAtMS = row.MetricsAtMS
		stores[i].MetricsError = row.MetricsError
		stores[i].Currency = row.Currency
		stores[i].Counts = row.Counts
		stores[i].Freshness = domain.StoreFreshness(row.LastFullSyncAtMS, row.ConsecutiveFailures, nowMS)
		if assignee := byID[stores[i].StoreID].Assignee(); assignee != nil {
			name := assignee.Name
			stores[i].AssigneeName = &name
		}
	}
	return domain.BuildOverview(stores, nowMS, syncDisabled), nil
}

// syncState is the narrow sync row the manual press decides from.
type syncState struct {
	Pass                *string
	Hold                *string
	HoldUntilMS         *int64
	ManualRequestedAtMS *int64
	RefreshGeneration   int64
	InflightUntilMS     *int64
	Pending             bool
}

// loadSyncState reads the press's decision inputs under the row lock.
func loadSyncState(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, lock bool) (syncState, *contract.APIError) {
	query := `
		SELECT pass, hold, hold_until_ms, manual_requested_at_ms, refresh_generation,
		       inflight_until_ms,
		       EXISTS (SELECT 1 FROM public.jobs j
		                WHERE j.org_id = $2 AND j.kind = 'store.product_sync'
		                  AND j.state IN ('queued', 'retry_wait', 'running')
		                  AND j.payload->>'storeId' = $1)
		  FROM public.store_product_sync
		 WHERE store_id = $1::uuid AND org_id = $2`
	if lock {
		query += " FOR UPDATE"
	}
	var out syncState
	err := tx.QueryRow(ctx, query, storeUUID, orgID).Scan(
		&out.Pass, &out.Hold, &out.HoldUntilMS, &out.ManualRequestedAtMS,
		&out.RefreshGeneration, &out.InflightUntilMS, &out.Pending)
	if errors.Is(err, pgx.ErrNoRows) {
		return syncState{}, &contract.APIError{
			Status: 500, Code: contract.CodeInternal, Message: contract.MsgUnavailable,
		}
	}
	if err != nil {
		return syncState{}, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}

// ensureSyncRow materializes the row a store's press and dedup stamp need. A
// store the scheduler never woke can still be refreshed on demand.
func ensureSyncRow(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string) *contract.APIError {
	_, err := tx.Exec(ctx, `
		INSERT INTO public.store_product_sync
		       (org_id, store_id, refresh_generation, pass, next_due_at_ms)
		VALUES ($1, $2::uuid, 1, 'none', 0)
		ON CONFLICT (store_id) DO NOTHING`, orgID, storeUUID)
	if err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	return nil
}

// stampManualPress records the press. `nextDue` moves only when the press
// queues a walk; an attach leaves the schedule alone.
func stampManualPress(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, nowMS int64, nextDue *int64) *contract.APIError {
	var due any
	if nextDue != nil {
		due = *nextDue
	}
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET manual_requested_at_ms = $3,
		       next_due_at_ms = COALESCE($4, next_due_at_ms)
		 WHERE store_id = $1::uuid AND org_id = $2`, storeUUID, orgID, nowMS, due)
	if err != nil {
		return asAPIError(err, contract.MsgUnavailable)
	}
	return nil
}

// isPressureStatus reports the statuses the incident ledger records.
func isPressureStatus(status int) bool { return status == 429 || status >= 500 }

// recordIncident inserts one pressure signal. Best effort: callers must not
// fail a request because the ledger write failed.
func recordIncident(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, clientID, path, origin string, status int, nowMS int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO public.seller_read_incidents
		       (org_id, store_id, client_id, path, status, retry_after_ms, origin, at_ms)
		VALUES ($1, $2::uuid, $3, $4, $5::smallint, NULL, $6, $7)`,
		orgID, storeUUID, clientID, path, status, origin, nowMS)
	return err
}

// claimVerify is the 60 s same-batch dedup as a CAS. The stamp pair moves
// together, so a concurrent same-batch claim waits on this row, then sees the
// committed stamp and matches nothing.
func claimVerify(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, digest string, nowMS int64) (bool, *contract.APIError) {
	const dedupMS = 60_000
	var won bool
	err := tx.QueryRow(ctx, `
		UPDATE public.store_product_sync
		   SET last_verify_at_ms = $3, last_verify_digest = $4
		 WHERE store_id = $1::uuid AND org_id = $2
		   AND NOT COALESCE(last_verify_at_ms > $3 - $5
		                    AND last_verify_digest = $4, false)
		 RETURNING true`, storeUUID, orgID, nowMS, digest, dedupMS).Scan(&won)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, asAPIError(err, contract.MsgUnavailable)
	}
	return won, nil
}

// releaseVerify undoes this request's own stamp after a failed call. A later
// claim's stamp is left alone by the equality predicate.
func releaseVerify(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID, digest string, nowMS int64) {
	_, _ = tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET last_verify_at_ms = NULL, last_verify_digest = NULL
		 WHERE store_id = $1::uuid AND org_id = $2
		   AND last_verify_at_ms = $3 AND last_verify_digest = $4`,
		storeUUID, orgID, nowMS, digest)
}

// ensureStatusID resolves the dictionary row for one status combination,
// inserting it on first sight. The `WHERE NOT EXISTS` guard is load-bearing:
// Postgres evaluates an identity default before it resolves ON CONFLICT, so a
// plain upsert burns one id per write until the smallint space runs out.
func ensureStatusID(ctx context.Context, tx pgx.Tx, isArchived bool, status, statusName, moderate, validation string) (int16, error) {
	state := classifyProductState(isArchived, status, statusName, moderate, validation)
	var id int16
	err := tx.QueryRow(ctx, `
		WITH inserted AS (
		    INSERT INTO public.ozon_product_status
		           (is_archived, status, status_name, moderate_status, validation_status, state)
		    SELECT $1, $2, $3, $4, $5, $6
		     WHERE NOT EXISTS (SELECT 1 FROM public.ozon_product_status
		                        WHERE is_archived = $1 AND status = $2 AND status_name = $3
		                          AND moderate_status = $4 AND validation_status = $5)
		    ON CONFLICT (is_archived, status, status_name, moderate_status, validation_status)
		    DO UPDATE SET state = EXCLUDED.state
		    RETURNING id)
		SELECT id FROM inserted
		UNION ALL
		SELECT id FROM public.ozon_product_status
		 WHERE is_archived = $1 AND status = $2 AND status_name = $3
		   AND moderate_status = $4 AND validation_status = $5
		LIMIT 1`,
		isArchived, status, statusName, moderate, validation, state).Scan(&id)
	return id, err
}

// classifyProductState is the shared rule table: archived wins over every
// text, a failure needle outranks a pending one, and silence is not a sale.
func classifyProductState(isArchived bool, status, statusName, moderate, validation string) string {
	if isArchived {
		return "archived"
	}
	combined := lowerASCII(status + " " + statusName + " " + moderate + " " + validation)
	if containsAny(combined, "declin", "отклон", "fail") {
		return "moderation_failed"
	}
	if containsAny(combined, "модера", "провер", "готов к продаже", "moder", "pending",
		"created", "validation", "обнов", "updating") {
		return "processing"
	}
	if containsAny(combined, "снят", "delist", "disabled", "rejected", "не прода") {
		return "hidden"
	}
	if containsAny(combined, "продается", "в продаже", "ready_for_sale", "price_sent", "active") {
		return "on_sale"
	}
	return "hidden"
}

func containsAny(haystack string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(haystack, needle) {
			return true
		}
	}
	return false
}

// lowerASCII lowercases without touching multibyte runs. The needle table mixes
// Cyrillic and ASCII, and only the ASCII half may change case.
func lowerASCII(value string) string {
	return strings.ToLower(value)
}

func containsString(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

// ProductRead posts POST /v3/product/info/list through the Seller egress. A
// non-loopback base is refused by the egress before a dial; the caller reports
// that as an unreachable gateway.
func (r Repo) ProductRead(ctx context.Context, clientID, apiKey string, offerIDs []string) (int, []byte, error) {
	body, err := json.Marshal(map[string]any{"offer_id": offerIDs})
	if err != nil {
		return 0, nil, err
	}
	return r.sellerRead(ctx, "/v3/product/info/list", body, clientID, apiKey)
}

// ProductQuotaRead reads POST /v4/product/info/limit: Ozon's own upload quota,
// not the Workspace store-seat quota.
func (r Repo) ProductQuotaRead(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	return r.sellerRead(ctx, "/v4/product/info/limit", []byte(`{}`), clientID, apiKey)
}

// ArchivedCountRead reads the ARCHIVED total from POST /v3/product/list. The
// cabinet refunds +1 to the assortment limit per archived product, so the
// count is what turns `total.limit` into an effective limit.
func (r Repo) ArchivedCountRead(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	body, err := json.Marshal(map[string]any{
		"filter": map[string]any{"visibility": "ARCHIVED"},
		"limit":  1,
	})
	if err != nil {
		return 0, nil, err
	}
	return r.sellerRead(ctx, "/v3/product/list", body, clientID, apiKey)
}

// FinanceBalanceRead reads POST /v1/finance/balance for one closed report
// window.
func (r Repo) FinanceBalanceRead(ctx context.Context, clientID, apiKey, from, to string) (int, []byte, error) {
	body, err := json.Marshal(map[string]any{"date_from": from, "date_to": to})
	if err != nil {
		return 0, nil, err
	}
	return r.sellerRead(ctx, "/v1/finance/balance", body, clientID, apiKey)
}

// sellerRead is the one shape every mirror read uses: interactive, read-only,
// and refused before a dial when no egress is bound.
func (r Repo) sellerRead(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	if r.egress == nil {
		return 0, nil, ErrNoEgress
	}
	return r.egress.SellerRead(ctx, path, body, clientID, apiKey)
}

// ThumbnailSource reads the stored primary image for one product. A missing row
// and an empty image are both "no such product" to the caller.
func (r Repo) ThumbnailSource(ctx context.Context, orgID int64, storeUUID string, productID int64) (string, *contract.APIError) {
	var image *string
	err := r.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT p.primary_image
			  FROM public.store_products p
			  JOIN public.organization_stores s ON s.id = p.store_pk AND s.org_id = p.org_id
			 WHERE p.org_id = $1 AND s.uuid = $2::uuid AND p.product_id = $3
			   AND s.deleted_at_ms IS NULL
			 LIMIT 1`, orgID, storeUUID, productID).Scan(&image)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", asAPIError(err, contract.MsgUnavailable)
	}
	if image == nil {
		return "", nil
	}
	return strings.TrimSpace(*image), nil
}
