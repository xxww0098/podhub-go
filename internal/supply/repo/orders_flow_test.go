package supplyrepo

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

func TestQuoteConfirmIsolatesOrg(t *testing.T) {
	pool, ctx := parityDB(t)
	userA := int64(884001)
	orgA := seedOrg(t, ctx, pool, userA, "ord-a")
	row := uuid.NewString()
	store := uuid.NewString()
	sku := "sku-ord-" + uuid.NewString()
	product := "prod-" + sku
	file := "11111111-1111-4111-8111-111111111111"
	t.Cleanup(func() { dropOrderFlow(context.Background(), pool, orgA, userA, sku, product, row) })
	if _, err := pool.Exec(ctx, `INSERT INTO listing_rows (id, org_id, card_id, store_id) VALUES ($1, $2, $3, $4)`, row, orgA, uuid.NewString(), store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores (org_id, uuid, create_order, name) VALUES ($1, $2, 1, 'shop')`, orgA, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_products (product_id, title, description, created_at_ms, updated_at_ms, created_by_account_uuid, published)
		VALUES ($1, '公开短袖', '卖家可见描述', 1, 1, 'test', true)`, product); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_skus (sku_id, product_id, platform_code, title, lead_time, created_at_ms, updated_at_ms, created_by_account_uuid, published)
		VALUES ($1, $2, $3, '短袖', '3-5 天', 2, 2, 'test', true)`, sku, product, "code-"+sku); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_price_versions (sku_id, price_cents, created_at_ms, created_by_account_uuid)
		VALUES ($1, 1250, 3, 'test')`, sku); err != nil {
		t.Fatal(err)
	}
	repo := New(pool, tenant.BeginApp)
	if _, err := repo.CreateQuote(ctx, orgA, userA, row, 2, "quote-missing", 1_000); err == nil || !strings.Contains(err.Error(), "请先绑定平台 SKU") {
		t.Fatalf("missing binding %v", err)
	}
	hash := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	bound, err := repo.PutBinding(ctx, orgA, userA, row, []domain.ProductionFile{{MediaAssetID: file, ContentHash: hash, HasHash: true}}, sku, 2, 1_000)
	if err != nil || bound.PlatformSKUID != sku || bound.QuantityPlaceholder != 2 || len(bound.ProductionFiles) != 1 {
		t.Fatalf("bind %+v %v", bound, err)
	}
	quote, err := repo.CreateQuote(ctx, orgA, userA, row, 2, "quote-1", 10_000)
	if err != nil || quote.UnitPlatformPriceCents != 1250 || quote.Quantity != 2 || quote.AmountCents != 2500 || quote.Currency != "CNY" {
		t.Fatalf("quote %+v %v", quote, err)
	}
	again, err := repo.CreateQuote(ctx, orgA, userA, row, 2, "quote-1", 99_000)
	if err != nil || again.QuoteID != quote.QuoteID || again.ExpiresAtMs != quote.ExpiresAtMs {
		t.Fatalf("replay %+v %v", again, err)
	}
	if _, err := repo.ConfirmOrder(ctx, orgA, userA+1, quote.QuoteID, "order-1", 10_000); err == nil || !strings.Contains(err.Error(), "所有者") {
		t.Fatalf("member %v", err)
	}
	instance := fmt.Sprintf("axum-%d", os.Getpid())
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('entitlement', 'axum', $1, 4, 0,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, 'test')`, instance); err != nil {
		t.Fatal(err)
	}
	order, err := repo.ConfirmOrder(ctx, orgA, userA, quote.QuoteID, "order-1", 10_000)
	if err != nil || order.Status != "awaiting_payment" || order.AmountCents != 2500 || !strings.HasPrefix(order.PaymentOrderPublicID, "pg_") {
		t.Fatalf("order %+v %v", order, err)
	}
	replay, err := repo.ConfirmOrder(ctx, orgA, userA, quote.QuoteID, "order-1", 80_000)
	if err != nil || replay.OrderID != order.OrderID || replay.PaymentOrderPublicID != order.PaymentOrderPublicID {
		t.Fatalf("order replay %+v %v", replay, err)
	}
	userB := int64(884002)
	orgB := seedOrg(t, ctx, pool, userB, "ord-b")
	t.Cleanup(func() { dropOrderFlow(context.Background(), pool, orgB, userB, "", "", "") })
	if _, err := repo.GetOrder(ctx, orgB, order.OrderID); err == nil || !strings.Contains(err.Error(), "记录不存在或未上架") {
		t.Fatalf("cross org %v", err)
	}
	public, err := repo.PublicCatalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, productRow := range public.Products {
		if productRow.ProductID == product {
			seen = true
			if productRow.Description != "卖家可见描述" || len(productRow.SKUs) != 1 || productRow.SKUs[0].SKUID != sku {
				t.Fatalf("public %+v", productRow)
			}
		}
	}
	if !seen {
		t.Fatal("published product missing")
	}
	seller, err := repo.SellerSKU(ctx, orgA, sku)
	if err != nil || seller.PlatformPriceCents != 1250 || !seller.Available || seller.Publication != "published" || seller.LeadTime != "3-5 天" {
		t.Fatalf("sku %+v %v", seller, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'entitlement' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('entitlement', 'axum', 'other', 1, 1, 2, 1, 'test')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM writer_leases WHERE domain = 'entitlement' AND holder_instance = 'other'`)
	})
	if _, err := repo.ConfirmOrder(ctx, orgA, userA, quote.QuoteID, "order-leased", 10_000); err == nil || !strings.Contains(err.Error(), "平台订单写入未启用") {
		t.Fatalf("lease %v", err)
	}
	_ = contract.ErrNotFound
}

func dropOrderFlow(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, sku, product, row string) {
	_, _ = pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'entitlement' AND holder_instance = 'other'`)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_order_lines WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_orders WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM payment_orders WHERE org_id = $1 AND product = 'platform_goods'`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_order_quotes WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE org_id = $1 AND action = 'platform_order_confirmed'`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_listing_bindings WHERE org_id = $1`, orgID)
	if sku != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM sc_price_versions WHERE sku_id = $1`, sku)
		_, _ = pool.Exec(ctx, `DELETE FROM sc_skus WHERE sku_id = $1`, sku)
	}
	if product != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM sc_products WHERE product_id = $1`, product)
	}
	if row != "" {
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE id = $1`, row)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = $1`, userID)
}
