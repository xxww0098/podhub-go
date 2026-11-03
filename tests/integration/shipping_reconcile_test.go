package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	shippingrepo "github.com/xxww0098/podhub-go/internal/shipping/repo"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
)

type shippingRead func(context.Context, string, []byte, bool, string, string) (int, []byte, error)

func (read shippingRead) Post(ctx context.Context, path string, body []byte, write bool, clientID, apiKey string) (int, []byte, error) {
	return read(ctx, path, body, write, clientID, apiKey)
}

func shippingReconcileFixture(t *testing.T) (context.Context, *pgxpool.Pool, shippingrepo.Repo, string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	pool := migratedPool(t, ctx)
	owner := int64(97731)
	org := seedCompanyOrg(t, ctx, pool, owner, "shipping-credential")
	seedCompanyMember(t, ctx, pool, org, owner, "owner", 1)
	seedMatchingLease(t, ctx, pool, "entitlement", "shipping credential")
	store := uuid.NewString()
	seedCompanyStore(t, ctx, pool, org, store, 1, "shipping store", nil)
	ring := seal.Ring{Primary: seal.DeriveKEK("shipping-reconcile-fixture")}
	directory := storerepo.New(pool, tenantx.BeginApp).WithCredentialKey(ring, true, seal.DefaultSellerKeyID,
		storeCredentialProbe(func(context.Context, string, string) (int, []byte, error) {
			return http.StatusOK, []byte(`{}`), nil
		}))
	svc := storesvc.New(directory, nil).WithRoster(directory).WithCredentialDirectory(directory)
	if _, api := svc.RegisterCredential(ctx, org, owner, store, "shipping-client", "shipping-fixture-key", 1, nil, true); api != nil {
		t.Fatal(api)
	}
	preset := "shipping-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO shipping_presets
		(preset_id,name,current_version,created_at_ms,updated_at_ms,created_by_account_uuid)
		VALUES($1,'shipping fixture',1,1,1,'fixture')`, preset); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shipping_preset_versions
		(preset_id,version,payload,created_at_ms,created_by_account_uuid)
		VALUES($1,1,'{"mode":"aggregator","warehouseName":"wanted","cutIn":30}',1,'fixture')`, preset); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO shipping_shop_injections
		(org_id,store_uuid,preset_id,pinned_version,status,warehouse_mutate_count,created_at_ms,updated_at_ms)
		VALUES($1,$2::uuid,$3,1,'unknown',1,1,1)`, org, store, preset); err != nil {
		t.Fatal(err)
	}
	return ctx, pool, shippingrepo.Repo{Pool: pool, Ring: ring, KeyReady: true}, store, preset
}

func TestShippingReconcileOpensRegisteredCredential(t *testing.T) {
	ctx, pool, repo, store, preset := shippingReconcileFixture(t)
	calls := 0
	now := time.Now().UnixMilli()
	_, err := repo.Reconcile(ctx, store, preset, now, shippingRead(func(_ context.Context, path string, _ []byte, write bool, clientID, apiKey string) (int, []byte, error) {
		calls++
		if path != "/v2/warehouse/list" || write || clientID != "shipping-client" || apiKey != "shipping-fixture-key" {
			t.Fatal("shipping reconciliation did not use the registered credential for its warehouse read")
		}
		return http.StatusOK, []byte(`{"warehouses":[],"has_next":false}`), nil
	}))
	if err != nil || calls != 1 {
		t.Fatalf("registered credential could not reconcile: calls=%d error=%v", calls, err)
	}
	var absent *int64
	if err := pool.QueryRow(ctx, `SELECT remote_absent_at_ms FROM shipping_shop_injections
		WHERE store_uuid=$1::uuid AND preset_id=$2`, store, preset).Scan(&absent); err != nil {
		t.Fatal(err)
	}
	if absent == nil || *absent != now {
		t.Fatalf("complete empty read did not persist its absence proof: %v", absent)
	}
}

func TestShippingIncompleteReadNeverProvesWarehouseAbsent(t *testing.T) {
	ctx, pool, repo, store, preset := shippingReconcileFixture(t)
	for _, tc := range []struct {
		name  string
		reply func(int) (int, string)
	}{
		{"missing list", func(int) (int, string) { return 200, `{}` }},
		{"null list", func(int) (int, string) { return 200, `{"warehouses":null}` }},
		{"invalid json", func(int) (int, string) { return 200, `{"warehouses":` }},
		{"invalid row", func(int) (int, string) { return 200, `{"warehouses":[{"name":"other","warehouse_id":0}]}` }},
		{"obsolete response", func(int) (int, string) { return 200, `{"code":9,"message":"obsolete"}` }},
		{"missing cursor", func(int) (int, string) {
			return 200, `{"warehouses":[{"name":"other","warehouse_id":1}],"has_next":true}`
		}},
		{"repeated cursor", func(int) (int, string) {
			return 200, `{"warehouses":[{"name":"other","warehouse_id":1}],"has_next":true,"cursor":"same"}`
		}},
		{"later page failed", func(call int) (int, string) {
			if call == 1 {
				return 200, `{"warehouses":[{"name":"other","warehouse_id":1}],"has_next":true,"cursor":"next"}`
			}
			return 503, `{}`
		}},
		{"page limit", func(call int) (int, string) {
			return 200, fmt.Sprintf(`{"warehouses":[{"name":"other","warehouse_id":%d}],"has_next":true,"cursor":"%d"}`, call, call)
		}},
		{"empty intermediate page", func(int) (int, string) { return 200, `{"warehouses":[],"has_next":true,"cursor":"next"}` }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, `UPDATE shipping_shop_injections SET remote_absent_at_ms=1
				WHERE store_uuid=$1::uuid AND preset_id=$2`, store, preset); err != nil {
				t.Fatal(err)
			}
			calls := 0
			raw, err := repo.Reconcile(ctx, store, preset, time.Now().UnixMilli(), shippingRead(func(_ context.Context, path string, _ []byte, write bool, _, _ string) (int, []byte, error) {
				if path != "/v2/warehouse/list" || write {
					t.Fatalf("incomplete read dispatched unexpected request: path=%s write=%v", path, write)
				}
				calls++
				status, body := tc.reply(calls)
				return status, []byte(body), nil
			}))
			if err != nil || calls == 0 {
				t.Fatalf("warehouse read did not run: calls=%d error=%v", calls, err)
			}
			var absent *int64
			if err := pool.QueryRow(ctx, `SELECT remote_absent_at_ms FROM shipping_shop_injections
				WHERE store_uuid=$1::uuid AND preset_id=$2`, store, preset).Scan(&absent); err != nil {
				t.Fatal(err)
			}
			var result struct {
				Data struct {
					Injection struct {
						CanSafeContinue bool `json:"canSafeContinue"`
					} `json:"injection"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if absent != nil || result.Data.Injection.CanSafeContinue {
				t.Fatalf("incomplete read authorized another warehouse creation: proof=%v canSafeContinue=%v", absent, result.Data.Injection.CanSafeContinue)
			}
		})
	}
}

func TestShippingCredentialGenerationAndKeyBinding(t *testing.T) {
	for _, tc := range []struct {
		name string
		open bool
	}{
		{"bound v1", true},
		{"previous key label", true},
		{"current key label with previous ciphertext", false},
		{"superseded generation", false},
		{"relabelled generation", false},
		{"invalid fingerprint", false},
		{"expired credential", false},
		{"deleted store", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, pool, repo, store, preset := shippingReconcileFixture(t)
			var org, storeID, revision int64
			if err := pool.QueryRow(ctx, `SELECT org_id,id,credential_revision FROM organization_stores WHERE uuid=$1::uuid`, store).Scan(&org, &storeID, &revision); err != nil {
				t.Fatal(err)
			}
			var err error
			switch tc.name {
			case "bound v1":
				nonce, ciphertext, sealErr := seal.SealBlob(repo.Ring.Primary, seal.StoreAAD(org, storeID, revision), []byte("shipping-fixture-key"))
				if sealErr != nil {
					t.Fatal(sealErr)
				}
				_, err = pool.Exec(ctx, `UPDATE store_seller_credentials SET envelope_version=1,client_id='shipping-client',
					nonce=$2,ciphertext=$3,wrapped_dek=NULL,dek_nonce=NULL WHERE store_id=$1`, storeID, nonce, ciphertext)
			case "previous key label", "current key label with previous ciphertext":
				repo.Ring.Previous, repo.Ring.Primary = repo.Ring.Primary, seal.DeriveKEK("shipping-next-fixture-key")
				repo.KeyID = "next-key"
				if !tc.open {
					repo.KeyID = seal.DefaultSellerKeyID
				}
				_, err = pool.Exec(ctx, `UPDATE store_seller_credentials SET key_fingerprint=$2 WHERE store_id=$1`, storeID,
					seal.Fingerprint(repo.Ring.Primary, "shipping-client", "shipping-fixture-key"))
			case "superseded generation":
				_, err = pool.Exec(ctx, `UPDATE organization_stores SET credential_revision=credential_revision+1 WHERE id=$1`, storeID)
			case "relabelled generation":
				_, err = pool.Exec(ctx, `UPDATE store_seller_credentials SET credential_revision=credential_revision+1 WHERE store_id=$1`, storeID)
				if err == nil {
					_, err = pool.Exec(ctx, `UPDATE organization_stores SET credential_revision=credential_revision+1 WHERE id=$1`, storeID)
				}
			case "invalid fingerprint":
				_, err = pool.Exec(ctx, `UPDATE store_seller_credentials SET key_fingerprint=$2 WHERE store_id=$1`, storeID, make([]byte, 32))
			case "expired credential":
				_, err = pool.Exec(ctx, `UPDATE store_seller_credentials SET key_expires_at_ms=1 WHERE store_id=$1`, storeID)
			case "deleted store":
				_, err = pool.Exec(ctx, `UPDATE organization_stores SET deleted_at_ms=1 WHERE id=$1`, storeID)
			}
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			_, err = repo.Reconcile(ctx, store, preset, time.Now().UnixMilli(), shippingRead(func(_ context.Context, _ string, _ []byte, write bool, clientID, apiKey string) (int, []byte, error) {
				calls++
				if write || clientID != "shipping-client" || apiKey != "shipping-fixture-key" {
					t.Fatal("credential opened as a different pair or reached a write")
				}
				return http.StatusOK, []byte(`{"warehouses":[],"has_next":false}`), nil
			}))
			if tc.open {
				if err != nil || calls != 1 {
					t.Fatalf("valid credential rejected: calls=%d error=%v", calls, err)
				}
			} else if err == nil || calls != 0 {
				t.Fatalf("invalid credential reached warehouse read: calls=%d error=%v", calls, err)
			}
		})
	}
}
