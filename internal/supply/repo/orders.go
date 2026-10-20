package supplyrepo

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

const quoteTTLMS int64 = 15 * 60 * 1000

func (r Repo) CreateQuote(ctx context.Context, orgID, userID int64, listingRowID string, quantity int64, key string, nowMs int64) (contract.QuoteData, error) {
	var out contract.QuoteData
	var raced *quoteRace
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		row, err := insertQuote(ctx, tx, orgID, userID, listingRowID, quantity, key, nowMs)
		var race quoteRace
		if errors.As(err, &race) {
			raced = &race
			return err
		}
		out = row
		return err
	})
	if raced != nil {
		return r.quoteByKey(ctx, orgID, key, raced.hash)
	}
	return out, err
}

type quoteRace struct{ hash string }

func (quoteRace) Error() string { return "quote unique" }

func insertQuote(ctx context.Context, tx pgx.Tx, orgID, userID int64, listingRowID string, quantity int64, key string, nowMs int64) (contract.QuoteData, error) {
	listing, storeID, err := loadListing(ctx, tx, orgID, listingRowID)
	if err != nil {
		return contract.QuoteData{}, err
	}
	binding, err := loadBinding(ctx, tx, orgID, listing)
	if err != nil {
		if f, ok := contract.AsFailure(err); ok && f.Status == 404 {
			return contract.QuoteData{}, fail(400, "MISSING_BINDING", "请先绑定平台 SKU")
		}
		return contract.QuoteData{}, mapDB(err)
	}
	sku, priceID, price, err := loadPricedSKU(ctx, tx, binding.PlatformSKUID, true)
	if err != nil {
		return contract.QuoteData{}, err
	}
	amount, ok := mulCents(price, quantity)
	if !ok {
		return contract.QuoteData{}, fail(400, "VALIDATION", "请先设置平台价")
	}
	hash := domain.RequestHash(listing, sku, strconv.FormatInt(quantity, 10), strconv.FormatInt(priceID, 10))
	existing, found, err := quoteByKeyTx(ctx, tx, orgID, key)
	if err != nil {
		return contract.QuoteData{}, err
	}
	if found {
		if existing.hash == hash {
			return existing.data, nil
		}
		return contract.QuoteData{}, fail(409, "CONFLICT", "同一幂等键已用于不同请求")
	}
	actor, err := accountPublicID(ctx, tx, userID)
	if err != nil {
		return contract.QuoteData{}, err
	}
	quoteID := domain.MintID("scq")
	_, err = tx.Exec(ctx, `
		INSERT INTO public.sc_order_quotes (
		    quote_id, org_id, store_id, listing_row_id, platform_sku_id,
		    request_hash, price_version_id, unit_price_cents, quantity,
		    amount_cents, currency, expires_at_ms, idempotency_key,
		    created_at_ms, created_by_account_uuid
		) VALUES (
		    $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 'CNY',
		    $11, $12, $13, $14
		)`, quoteID, orgID, storeID, listing, sku, hash, priceID, price, quantity, amount, nowMs+quoteTTLMS, key, nowMs, actor)
	if isUnique(err) {
		return contract.QuoteData{}, quoteRace{hash: hash}
	}
	if err != nil {
		return contract.QuoteData{}, mapDB(err)
	}
	return loadQuote(ctx, tx, orgID, quoteID)
}

func (r Repo) quoteByKey(ctx context.Context, orgID int64, key, wantHash string) (contract.QuoteData, error) {
	var out contract.QuoteData
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		row, found, err := quoteByKeyTx(ctx, tx, orgID, key)
		if err != nil {
			return err
		}
		if !found {
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		if row.hash != wantHash {
			return fail(409, "CONFLICT", "同一幂等键已用于不同请求")
		}
		out = row.data
		return nil
	})
	return out, err
}

func (r Repo) ConfirmOrder(ctx context.Context, orgID, userID int64, quoteID, key string, nowMs int64) (contract.OrderData, error) {
	if err := r.requireOwner(ctx, orgID, userID); err != nil {
		return contract.OrderData{}, err
	}
	var out contract.OrderData
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		if err := assertEntitlement(ctx, tx); err != nil {
			return err
		}
		row, quote, err := confirm(ctx, tx, orgID, userID, quoteID, key, nowMs)
		if err != nil {
			return err
		}
		if err := insertOrderAudit(ctx, tx, orgID, userID, quote, row); err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

func (r Repo) GetOrder(ctx context.Context, orgID int64, orderID string) (contract.OrderData, error) {
	var out contract.OrderData
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		row, found, err := loadOrder(ctx, tx, orgID, `order_id = $2`, strings.TrimSpace(orderID))
		if err != nil {
			return err
		}
		if !found {
			return fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		out = row.data
		return nil
	})
	return out, err
}

func (r Repo) requireOwner(ctx context.Context, orgID, userID int64) error {
	return r.tx(ctx, orgID, func(tx pgx.Tx) error {
		var owner int64
		err := tx.QueryRow(ctx, `SELECT owner_user_id FROM public.organizations WHERE id = $1 LIMIT 1`, orgID).Scan(&owner)
		if err != nil {
			return mapDB(err)
		}
		if owner != userID {
			return fail(403, "FORBIDDEN", "只有 Workspace 所有者可以确认平台订单")
		}
		return nil
	})
}

func confirm(ctx context.Context, tx pgx.Tx, orgID, userID int64, quoteID, key string, nowMs int64) (contract.OrderData, string, error) {
	hash := domain.RequestHash(quoteID)
	existing, found, err := loadOrder(ctx, tx, orgID, `idempotency_key = $2`, key)
	if err != nil {
		return contract.OrderData{}, "", err
	}
	if found {
		if existing.hash != hash {
			return contract.OrderData{}, "", fail(409, "CONFLICT", "同一幂等键已用于不同请求")
		}
		return existing.data, existing.quoteID, nil
	}
	quote, found, err := loadQuoteRow(ctx, tx, orgID, quoteID)
	if err != nil {
		return contract.OrderData{}, "", err
	}
	if !found {
		return contract.OrderData{}, "", fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	if domain.QuoteExpired(quote.expires, nowMs) {
		return contract.OrderData{}, "", fail(400, "QUOTE_EXPIRED", "报价已过期")
	}
	if _, _, _, err := loadPricedSKU(ctx, tx, quote.sku, false); err != nil {
		return contract.OrderData{}, "", err
	}
	binding, err := loadBinding(ctx, tx, orgID, quote.listing)
	if err != nil {
		if f, ok := contract.AsFailure(err); ok && f.Status == 404 {
			return contract.OrderData{}, "", fail(400, "MISSING_BINDING", "请先绑定平台 SKU")
		}
		return contract.OrderData{}, "", mapDB(err)
	}
	if !domain.HasMaterial(domainFiles(binding.ProductionFiles)) {
		return contract.OrderData{}, "", fail(400, "MISSING_PRODUCTION_MATERIALS", "缺少生产文件，无法确认平台订单")
	}
	if binding.PlatformSKUID != quote.sku {
		return contract.OrderData{}, "", fail(400, "VALIDATION", "绑定的平台 SKU 与报价不一致")
	}
	actor, err := accountPublicID(ctx, tx, userID)
	if err != nil {
		return contract.OrderData{}, "", err
	}
	orderID := domain.MintID("sco")
	paymentID := domain.MintID("pg")
	raw, err := writeSnapshot(binding.PlatformSKUID, binding.SpecVersion, binding.DesignRevision, domainFiles(binding.ProductionFiles), binding.QuantityPlaceholder)
	if err != nil {
		return contract.OrderData{}, "", fail(500, "INTERNAL", "服务暂不可用")
	}
	if _, err := tx.Exec(ctx, `SAVEPOINT confirm_insert`); err != nil {
		return contract.OrderData{}, "", mapDB(err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO public.payment_orders
		    (public_id, org_id, product, plan, member_seats, months,
		     amount_cents, currency, provider, status,
		     created_by_user_id, created_at, updated_at)
		VALUES ($1, $2, 'platform_goods', NULL, NULL, 1, $3, 'CNY', 'manual', 'pending', $4,
		        clock_timestamp(), clock_timestamp())`, paymentID, orgID, quote.amount, userID)
	if err == nil {
		_, err = tx.Exec(ctx, `
			INSERT INTO public.sc_orders (
			    order_id, org_id, store_id, quote_id, listing_row_id,
			    platform_sku_id, spec_version, design_revision,
			    production_snapshot, unit_platform_price_cents, price_version_id,
			    quantity, amount_cents, currency, status, payment_order_public_id,
			    request_hash, idempotency_key, created_at_ms, updated_at_ms,
			    created_by_account_uuid
			) VALUES (
			    $1, $2, $3::uuid, $4, $5::uuid, $6, $7, $8, $9::jsonb, $10, $11,
			    $12, $13, 'CNY', 'awaiting_payment', $14, $15, $16, $17, $17, $18
			)`, orderID, orgID, quote.store, quote.id, quote.listing, quote.sku,
			binding.SpecVersion, binding.DesignRevision, string(raw), quote.unit, quote.priceID,
			quote.quantity, quote.amount, paymentID, hash, key, nowMs, actor)
	}
	if isUnique(err) {
		if _, rbErr := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT confirm_insert`); rbErr != nil {
			return contract.OrderData{}, "", mapDB(rbErr)
		}
		_, _ = tx.Exec(ctx, `DELETE FROM public.payment_orders WHERE public_id = $1 AND status = 'pending'`, paymentID)
		winner, ok, loadErr := loadOrder(ctx, tx, orgID, `idempotency_key = $2`, key)
		if loadErr != nil {
			return contract.OrderData{}, "", loadErr
		}
		if !ok {
			return contract.OrderData{}, "", fail(500, "INTERNAL", "服务暂不可用")
		}
		if winner.hash != hash {
			return contract.OrderData{}, "", fail(409, "CONFLICT", "同一幂等键已用于不同请求")
		}
		return winner.data, winner.quoteID, nil
	}
	if err != nil {
		return contract.OrderData{}, "", mapDB(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO public.sc_order_lines (
		    org_id, order_id, line_no, listing_row_id, platform_sku_id,
		    unit_platform_price_cents, quantity, amount_cents,
		    spec_version, design_revision
		) VALUES ($1, $2, 1, $3::uuid, $4, $5, $6, $7, $8, $9)`,
		orgID, orderID, quote.listing, quote.sku, quote.unit, quote.quantity, quote.amount,
		binding.SpecVersion, binding.DesignRevision); err != nil {
		return contract.OrderData{}, "", mapDB(err)
	}
	row, found, err := loadOrder(ctx, tx, orgID, `order_id = $2`, orderID)
	if err != nil {
		return contract.OrderData{}, "", err
	}
	if !found {
		return contract.OrderData{}, "", fail(500, "INTERNAL", "服务暂不可用")
	}
	return row.data, row.quoteID, nil
}

func assertEntitlement(ctx context.Context, tx pgx.Tx) error {
	_, err := writer.Assert(ctx, tx, "entitlement", writer.ProcessIdentity(), time.Now().UnixMilli(), "平台订单写入未启用")
	if writer.IsDisabled(err) {
		return fail(503, "WRITES_DISABLED", "平台订单写入未启用")
	}
	return mapDB(err)
}

func insertOrderAudit(ctx context.Context, tx pgx.Tx, orgID, userID int64, quoteID string, order contract.OrderData) error {
	raw, err := json.Marshal(struct {
		QuoteID   string `json:"quote_id"`
		PaymentID string `json:"payment_order_public_id"`
		Amount    int64  `json:"amount_cents"`
	}{quoteID, order.PaymentOrderPublicID, order.AmountCents})
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	leaseID, fence := writer.AuditArgs(tx)
	tag, err := tx.Exec(ctx, `
		INSERT INTO audit_logs
		    (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		     action, status, result, message, shop_id, created_at_ms, created_at,
		     actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, 'entitlement', 'platform_order', $3, 'POST', '/api/platform-orders',
		        'platform_order_confirmed', 'success', 'applied', $4, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $5, $6)`,
		orgID, userID, order.OrderID, string(raw), leaseID, fence)
	if err != nil {
		return mapDB(err)
	}
	if tag.RowsAffected() != 1 {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	return nil
}

func loadListing(ctx context.Context, tx pgx.Tx, orgID int64, listingRowID string) (string, string, error) {
	var id string
	var store *string
	err := tx.QueryRow(ctx, `
		SELECT id::text, store_id::text
		FROM public.listing_rows
		WHERE org_id = $1 AND id = $2::uuid`, orgID, listingRowID).Scan(&id, &store)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	if err != nil {
		return "", "", mapDB(err)
	}
	if store == nil || strings.TrimSpace(*store) == "" {
		return "", "", fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	return id, strings.TrimSpace(*store), nil
}

func loadPricedSKU(ctx context.Context, tx pgx.Tx, skuID string, needPrice bool) (string, int64, int64, error) {
	var sku string
	var skuPublished, productPublished bool
	var priceID, price *int64
	err := tx.QueryRow(ctx, `
		SELECT s.sku_id, s.published, p.published, v.id, v.price_cents
		FROM public.sc_skus s
		JOIN public.sc_products p ON p.product_id = s.product_id
		LEFT JOIN LATERAL (
		    SELECT id, price_cents FROM public.sc_price_versions
		    WHERE sku_id = s.sku_id ORDER BY id DESC LIMIT 1
		) v ON true
		WHERE s.sku_id = $1`, skuID).Scan(&sku, &skuPublished, &productPublished, &priceID, &price)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (!skuPublished || !productPublished)) {
		return "", 0, 0, fail(400, "SKU_UNPUBLISHED", "未上架的平台 SKU 不能下单")
	}
	if err != nil {
		return "", 0, 0, mapDB(err)
	}
	if !needPrice {
		return sku, 0, 0, nil
	}
	if priceID == nil || price == nil {
		return "", 0, 0, fail(400, "VALIDATION", "请先设置平台价")
	}
	return sku, *priceID, *price, nil
}

type quoteRow struct {
	data                    contract.QuoteData
	hash                    string
	id, store, listing, sku string
	priceID, unit, quantity int64
	amount, expires         int64
}

func quoteByKeyTx(ctx context.Context, tx pgx.Tx, orgID int64, key string) (quoteRow, bool, error) {
	return scanQuote(ctx, tx, `
		SELECT quote_id, store_id::text, listing_row_id::text, platform_sku_id,
		       request_hash, price_version_id, unit_price_cents, quantity,
		       amount_cents, currency, expires_at_ms, created_at_ms
		FROM public.sc_order_quotes
		WHERE org_id = $1 AND idempotency_key = $2`, orgID, key)
}

func loadQuote(ctx context.Context, tx pgx.Tx, orgID int64, quoteID string) (contract.QuoteData, error) {
	row, found, err := loadQuoteRow(ctx, tx, orgID, quoteID)
	if err != nil {
		return contract.QuoteData{}, err
	}
	if !found {
		return contract.QuoteData{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	return row.data, nil
}

func loadQuoteRow(ctx context.Context, tx pgx.Tx, orgID int64, quoteID string) (quoteRow, bool, error) {
	return scanQuote(ctx, tx, `
		SELECT quote_id, store_id::text, listing_row_id::text, platform_sku_id,
		       request_hash, price_version_id, unit_price_cents, quantity,
		       amount_cents, currency, expires_at_ms, created_at_ms
		FROM public.sc_order_quotes
		WHERE org_id = $1 AND quote_id = $2`, orgID, quoteID)
}

func scanQuote(ctx context.Context, tx pgx.Tx, sql string, args ...any) (quoteRow, bool, error) {
	var row quoteRow
	err := tx.QueryRow(ctx, sql, args...).Scan(
		&row.id, &row.store, &row.listing, &row.sku, &row.hash, &row.priceID, &row.unit,
		&row.quantity, &row.amount, &row.data.Currency, &row.expires, &row.data.CreatedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return quoteRow{}, false, nil
	}
	if err != nil {
		return quoteRow{}, false, mapDB(err)
	}
	row.data = contract.QuoteData{
		QuoteID: row.id, StoreID: row.store, ListingRowID: row.listing, PlatformSKUID: row.sku,
		PriceVersionID: row.priceID, UnitPlatformPriceCents: row.unit, Quantity: row.quantity,
		AmountCents: row.amount, Currency: row.data.Currency, ExpiresAtMs: row.expires, CreatedAtMs: row.data.CreatedAtMs,
	}
	return row, true, nil
}

type orderRow struct {
	data    contract.OrderData
	hash    string
	quoteID string
}

func loadOrder(ctx context.Context, tx pgx.Tx, orgID int64, pred, arg string) (orderRow, bool, error) {
	var row orderRow
	var snap []byte
	var status string
	err := tx.QueryRow(ctx, `
		SELECT order_id, store_id::text, listing_row_id::text, platform_sku_id,
		       spec_version, design_revision, production_snapshot,
		       unit_platform_price_cents, quantity, amount_cents, currency, status,
		       payment_order_public_id, request_hash, created_at_ms, updated_at_ms, quote_id
		FROM public.sc_orders
		WHERE org_id = $1 AND `+pred, orgID, arg).Scan(
		&row.data.OrderID, &row.data.StoreID, &row.data.ListingRowID, &row.data.PlatformSKUID,
		&row.data.SpecVersion, &row.data.DesignRevision, &snap,
		&row.data.UnitPlatformPriceCents, &row.data.Quantity, &row.data.AmountCents, &row.data.Currency, &status,
		&row.data.PaymentOrderPublicID, &row.hash, &row.data.CreatedAtMs, &row.data.UpdatedAtMs, &row.quoteID)
	if errors.Is(err, pgx.ErrNoRows) {
		return orderRow{}, false, nil
	}
	if err != nil {
		return orderRow{}, false, mapDB(err)
	}
	parsed, err := domain.SellerStatus(status)
	if err != nil {
		return orderRow{}, false, err
	}
	row.data.Status = parsed
	_, _, _, files, _ := readSnapshot(snap, row.data.PlatformSKUID, row.data.SpecVersion, row.data.DesignRevision)
	row.data.ProductionFiles = files
	return row, true, nil
}

func mulCents(price, qty int64) (int64, bool) {
	if price <= 0 || qty <= 0 {
		return 0, false
	}
	if price > math.MaxInt64/qty {
		return 0, false
	}
	return price * qty, true
}
