package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestDeleteSupplierDbWithRows(t *testing.T) {
	if !testkit.DockerAvailable() {
		t.Skip("docker daemon is not available")
	}
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", r2FixtureKey)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("podhub"), postgres.WithUsername("postgres"), postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(), testcontainers.WithCmdArgs("-c", "max_locks_per_transaction=256"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = container.Terminate(context.Background()) })
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id,public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at)
		VALUES (96301,'a96301','a96301@example.invalid','x','super_admin','Admin','/workspace','','lite',clock_timestamp(),clock_timestamp());
		INSERT INTO account_users (id,public_id,email,password_hash,role,name,target,supplier_id,plan,account_kind,created_at,updated_at)
		VALUES (96302,'s96302','s96302@example.invalid','x','user','Supplier','/supplier','','lite','supplier',clock_timestamp(),clock_timestamp());
		INSERT INTO organizations (id,owner_user_id,name,plan,created_at,updated_at)
		VALUES (96301,96301,'delete-test','lite',clock_timestamp(),clock_timestamp());
		INSERT INTO organization_members (org_id,user_id,role,status,display_name,created_at,updated_at,join_order)
		VALUES (96301,96301,'owner','active','Admin',clock_timestamp(),clock_timestamp(),1);`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_sessions (token_hash,user_id,expires_at)
		VALUES ($1,96301,clock_timestamp()+interval '1 day')`, admindomain.SessionHash("catalog-authority-admin")); err != nil {
		t.Fatal(err)
	}
	id := writer.ProcessIdentity()
	if _, err := pool.Exec(ctx, `INSERT INTO writer_leases
		(domain,holder,holder_instance,fence_token,granted_at_ms,expires_at_ms,heartbeat_at_ms,grant_reason)
		VALUES ('admin',$1,$2,1,0,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint+600000,
		        (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,'supplier delete test')`, id.Holder, id.InstanceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'supplier-delete-test'`); err != nil {
		t.Fatal(err)
	}
	loginURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	loginURL.User = url.UserPassword("podhub_login_api", "supplier-delete-test")
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	login, err := db.Connect(ctx, config.Config{DatabaseURL: loginURL.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(login.Close)
	handler := app.Handler(login)

	_, err = pool.Exec(ctx, `
		INSERT INTO sc_factories (factory_id,name,created_at_ms,updated_at_ms) VALUES ('delete-ok','Delete OK factory',1,1), ('delete-bound','Delete bound factory',1,1);
		INSERT INTO sc_sources (source_id,name,created_at_ms,updated_at_ms) VALUES
		  ('delete-ok','Delete OK',1,1), ('delete-bound','Delete bound',1,1),
		  ('delete-cross','Delete cross',1,1), ('delete-other','Other source',1,1),
		  ('delete-quoted','Delete quoted',1,1);
		UPDATE sc_sources SET factory_id=source_id WHERE source_id IN ('delete-ok','delete-bound');
		INSERT INTO sc_products (product_id,source_id,title,archived,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES
		  ('ok-active','delete-ok','Active',false,1,1,'fixture'),
		  ('ok-archived','delete-ok','Archived',true,1,1,'fixture'),
		  ('ok-no-sku','delete-ok','No SKU',false,1,1,'fixture'),
		  ('bound-product','delete-bound','Bound',false,1,1,'fixture'),
		  ('cross-product','delete-cross','Cross',false,1,1,'fixture'),
		  ('other-product','delete-other','Other',false,1,1,'fixture'),
		  ('quoted-product','delete-quoted','Quoted',false,1,1,'fixture'),
		  ('unassigned-product','src_unassigned','Unassigned',false,1,1,'fixture');
		INSERT INTO sc_skus (sku_id,product_id,platform_code,title,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES
		  ('ok-sku','ok-active','delete-ok-sku','Active',1,1,'fixture'),
		  ('ok-archived-sku','ok-archived','delete-ok-archived','Archived',1,1,'fixture'),
		  ('bound-sku','bound-product','delete-bound-sku','Bound',1,1,'fixture'),
		  ('cross-sku','cross-product','delete-cross-sku','Cross',1,1,'fixture'),
		  ('other-sku','other-product','delete-other-sku','Other',1,1,'fixture'),
		  ('quoted-sku','quoted-product','delete-quoted-sku','Quoted',1,1,'fixture'),
		  ('unassigned-sku','unassigned-product','delete-unassigned-sku','Unassigned',1,1,'fixture');
		INSERT INTO sc_price_versions (sku_id,price_cents,created_at_ms,created_by_account_uuid) VALUES
		  ('ok-sku',1000,1,'fixture'), ('bound-sku',1000,1,'fixture'), ('quoted-sku',1000,1,'fixture');
		INSERT INTO sc_source_offers (source_id,sku_id,cost_cents,created_at_ms,updated_at_ms) VALUES
		  ('delete-ok','ok-sku',100,1,1), ('delete-other','cross-sku',100,1,1),
		  ('delete-other','other-sku',100,1,1);
		INSERT INTO sc_source_prop_defs (prop_id,source_id,name,type,created_at_ms,updated_at_ms)
		  VALUES ('delete-prop','delete-ok','Property','text',1,1);
		INSERT INTO sc_factory_members (factory_id,user_id,created_by,created_at_ms) VALUES
		  ('delete-ok',96302,96301,1), ('delete-bound',96302,96301,1);
		INSERT INTO sc_catalog_managers (source_id,user_id,created_at_ms) VALUES ('delete-ok',96301,1);
		INSERT INTO sc_source_fulfillers (source_id,user_id,created_at_ms) VALUES ('delete-ok',96302,1);
		INSERT INTO supplier_wallets (source_id,balance_microfen,held_microfen,updated_at_ms)
		  VALUES ('delete-bound',1000,0,1);
		INSERT INTO shipping_presets (preset_id,name,current_version,created_at_ms,updated_at_ms,created_by_account_uuid)
		  VALUES ('delete-preset','Preset',1,1,1,'fixture');
		INSERT INTO shipping_sku_bindings (sku_id,preset_id,created_at_ms,updated_at_ms,created_by_account_uuid)
		  VALUES ('bound-sku','delete-preset',1,1,'fixture');
		INSERT INTO listing_rows (id,org_id,card_id)
		  VALUES ('10000000-0000-4000-8000-000000000001',96301,'10000000-0000-4000-8000-000000000002');
		INSERT INTO sc_order_quotes (quote_id,org_id,store_id,listing_row_id,platform_sku_id,request_hash,
		  price_version_id,unit_price_cents,quantity,amount_cents,expires_at_ms,idempotency_key,created_at_ms,created_by_account_uuid)
		  SELECT 'delete-quote',96301,'10000000-0000-4000-8000-000000000003',
		  '10000000-0000-4000-8000-000000000001','quoted-sku','hash',id,1000,1,1000,100,'key',1,'fixture'
		  FROM sc_price_versions WHERE sku_id='quoted-sku';`)
	if err != nil {
		t.Fatal(err)
	}
	remove := func(source string, want int) {
		t.Helper()
		request := httptest.NewRequest(http.MethodDelete, "/api/admin/supplier-dbs/"+source, nil).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer catalog-authority-admin")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("delete %s: status=%d want=%d body=%s", source, response.Code, want, response.Body.String())
		}
		if want == http.StatusConflict && !strings.Contains(response.Body.String(), "无法删除") {
			t.Fatalf("delete %s did not explain the conflict: %s", source, response.Body.String())
		}
	}
	count := func(query string, want int) {
		t.Helper()
		var got int
		if err := pool.QueryRow(ctx, query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s: got=%d want=%d err=%v", query, got, want, err)
		}
	}

	remove("delete-ok", http.StatusOK)
	count(`SELECT count(*) FROM sc_sources WHERE source_id='delete-ok'`, 0)
	count(`SELECT count(*) FROM sc_products WHERE source_id='delete-ok'`, 0)
	count(`SELECT count(*) FROM sc_skus WHERE sku_id IN ('ok-sku','ok-archived-sku')`, 0)
	count(`SELECT count(*) FROM sc_price_versions WHERE sku_id='ok-sku'`, 0)
	count(`SELECT count(*) FROM sc_source_offers WHERE source_id='delete-ok'`, 0)
	count(`SELECT count(*) FROM sc_source_prop_defs WHERE source_id='delete-ok'`, 0)
	count(`SELECT count(*) FROM sc_factory_members WHERE factory_id='delete-ok'`, 1)
	count(`SELECT count(*) FROM sc_catalog_managers WHERE source_id='delete-ok'`, 0)
	count(`SELECT count(*) FROM sc_source_fulfillers WHERE source_id='delete-ok'`, 0)
	count(`SELECT count(*) FROM audit_logs WHERE entity_id='delete-ok' AND action='sc_source_deleted'`, 1)
	count(`SELECT count(*) FROM sc_products WHERE source_id='delete-other'`, 1)

	remove("delete-bound", http.StatusConflict)
	count(`SELECT count(*) FROM sc_price_versions WHERE sku_id='bound-sku'`, 1)
	count(`SELECT count(*) FROM shipping_sku_bindings WHERE sku_id='bound-sku'`, 1)
	if _, err := pool.Exec(ctx, `DELETE FROM shipping_sku_bindings WHERE sku_id='bound-sku'`); err != nil {
		t.Fatal(err)
	}
	remove("delete-bound", http.StatusConflict)
	count(`SELECT count(*) FROM sc_products WHERE source_id='delete-bound'`, 1)
	count(`SELECT count(*) FROM sc_price_versions WHERE sku_id='bound-sku'`, 1)
	count(`SELECT count(*) FROM sc_factory_members WHERE factory_id='delete-bound'`, 1)
	count(`SELECT count(*) FROM supplier_wallets WHERE source_id='delete-bound' AND balance_microfen=1000`, 1)
	count(`SELECT count(*) FROM audit_logs WHERE entity_id='delete-bound' AND action='sc_source_deleted'`, 0)

	remove("delete-cross", http.StatusConflict)
	count(`SELECT count(*) FROM sc_source_offers WHERE source_id='delete-other' AND sku_id='cross-sku'`, 1)
	count(`SELECT count(*) FROM sc_products WHERE source_id='delete-cross'`, 1)

	remove("delete-quoted", http.StatusConflict)
	count(`SELECT count(*) FROM sc_order_quotes WHERE quote_id='delete-quote'`, 1)
	count(`SELECT count(*) FROM sc_price_versions WHERE sku_id='quoted-sku'`, 1)
	count(`SELECT count(*) FROM sc_products WHERE source_id='delete-quoted'`, 1)

	remove("src_unassigned", http.StatusOK)
	count(`SELECT count(*) FROM sc_sources WHERE source_id='src_unassigned'`, 0)
	count(`SELECT count(*) FROM sc_products WHERE product_id='unassigned-product'`, 0)
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id,name,created_at_ms,updated_at_ms)
		VALUES ('other-unassigned-name','未分配',1,1)`); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/admin/platform-catalog/products", strings.NewReader(`{"title":"New product"}`)).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer catalog-authority-admin")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create product after deleting unassigned: status=%d body=%s", response.Code, response.Body.String())
	}
	count(`SELECT count(*) FROM sc_sources WHERE source_id='src_unassigned'`, 1)
	count(`SELECT count(*) FROM sc_products WHERE source_id='src_unassigned' AND title='New product'`, 1)
	count(`SELECT count(*) FROM sc_sources WHERE source_id='other-unassigned-name' AND name='未分配'`, 1)
}
