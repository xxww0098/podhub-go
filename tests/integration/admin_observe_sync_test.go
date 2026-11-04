package integration

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	observecontract "github.com/xxww0098/podhub-go/internal/admin/observe/contract"
	observerepo "github.com/xxww0098/podhub-go/internal/admin/observe/repo"
)

func TestAdminObservationReadsStoreSyncStates(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	const ownerID, adminID int64 = 88141, 88142
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, 'observe-owner', 'observe-owner@example.invalid', 'x', 'user', 'Owner', '/workspace', '', 'free', clock_timestamp(), clock_timestamp()),
		       ($2, 'observe-admin', 'observe-admin@example.invalid', 'x', 'super_admin', 'Admin', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`, ownerID, adminID); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'observe-scope', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, ownerID).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	var storeID string
	if err := pool.QueryRow(ctx, `INSERT INTO organization_stores (org_id, create_order, name)
		VALUES ($1, 1, 'synced store') RETURNING uuid::text`, orgID).Scan(&storeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO store_product_sync (org_id, store_id, refresh_generation, pass, hold, hold_until_ms)
		VALUES ($1, $2::uuid, 1, 'detail', 'backoff', 1)`, orgID, storeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `WITH state AS (
		INSERT INTO ozon_product_status(is_archived,status,status_name,moderate_status,validation_status,state)
		VALUES(false,'observe-sku','Observed','approved','success','on_sale') RETURNING id
	) INSERT INTO store_products(org_id,store_pk,product_id,offer_id,sku,status_id,primary_image)
		SELECT s.org_id,s.id,1,'observed-sku',1234567890123456789,state.id,''
		FROM organization_stores s CROSS JOIN state WHERE s.uuid=$1::uuid`, storeID); err != nil {
		t.Fatal(err)
	}

	observe := observerepo.NewObserve(pool, nil)
	actor := corecontract.Actor{UserID: adminID}
	t.Run("product identifier", func(t *testing.T) {
		body, err := observe.Products(ctx, actor, observecontract.ProductQuery{Scope: observecontract.Scope{StoreID: storeID}})
		if err != nil {
			t.Fatal(err)
		}
		var response struct {
			Data struct {
				Items []struct {
					Product struct {
						SKU string `json:"sku"`
					} `json:"product"`
				} `json:"items"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &response); err != nil {
			t.Fatal(err)
		}
		if len(response.Data.Items) != 1 || response.Data.Items[0].Product.SKU != "1234567890123456789" {
			t.Fatalf("observation SKU lost decimal text: %s", body)
		}
	})
	t.Run("product without image or sku", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `WITH state AS (
			INSERT INTO ozon_product_status(is_archived,status,status_name,moderate_status,validation_status,state)
			VALUES(false,'observe-empty','Observed empty','approved','success','on_sale') RETURNING id
		) INSERT INTO store_products(org_id,store_pk,product_id,offer_id,sku,status_id,primary_image)
			SELECT s.org_id,s.id,2,'observed-no-image',0,state.id,NULL
			FROM organization_stores s CROSS JOIN state WHERE s.uuid=$1::uuid`, storeID); err != nil {
			t.Fatal(err)
		}
		body, err := observe.Products(ctx, actor, observecontract.ProductQuery{Scope: observecontract.Scope{StoreID: storeID}})
		if err != nil {
			t.Fatal(err)
		}
		var response struct {
			Data struct {
				Items []struct {
					Product struct {
						OfferID  string  `json:"offer_id"`
						SKU      *string `json:"sku"`
						ImageURL *string `json:"image_url"`
					} `json:"product"`
				} `json:"items"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &response); err != nil {
			t.Fatal(err)
		}
		if len(response.Data.Items) != 2 {
			t.Fatalf("observation items %d: %s", len(response.Data.Items), body)
		}
		for _, item := range response.Data.Items {
			if item.Product.OfferID != "observed-no-image" {
				continue
			}
			if item.Product.SKU != nil || item.Product.ImageURL != nil {
				t.Fatalf("null image or sku invented: %+v", item.Product)
			}
			return
		}
		t.Fatalf("null-image product missing: %s", body)
	})

	for _, test := range []struct {
		name string
		read func(context.Context, corecontract.Actor, observecontract.Scope) ([]byte, error)
		key  string
	}{
		{name: "console snapshot", read: observe.Snapshot, key: "products"},
		{name: "product overview", read: observe.Overview, key: "stores"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := test.read(ctx, actor, observecontract.Scope{})
			if err != nil {
				t.Fatal(err)
			}
			var response struct {
				Data map[string]json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(body, &response); err != nil {
				t.Fatal(err)
			}
			var rows []struct {
				StoreID string  `json:"store_id"`
				Pass    *string `json:"pass"`
				Hold    *string `json:"hold"`
			}
			if err := json.Unmarshal(response.Data[test.key], &rows); err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].StoreID != storeID || rows[0].Pass == nil || *rows[0].Pass != "detail" || rows[0].Hold == nil || *rows[0].Hold != "backoff" {
				t.Fatalf("unexpected sync state: %+v", rows)
			}
		})
	}
}
