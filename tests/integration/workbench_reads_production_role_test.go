package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestWorkbenchReadsProductionRole(t *testing.T) {
	f := newIdentityRuntimeFixture(t)
	var org, otherOrg int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96311`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96312`).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	const storeID = "11111111-2222-4333-8444-555555555555"
	insertNamedStore(t, f.ctx, f.fixture, org, storeID, 0)
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO console_store_metrics
		(org_id,store_id,refresh_generation,ordered_units_30d,day_series_14d,through_day,last_sync_at_ms)
		VALUES ($1,$2::uuid,1,4,array_fill(0::float8,ARRAY[14]),'2026-10-26',1)`, org, storeID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO store_product_sync
		(org_id,store_id,refresh_generation,count_total,count_on_sale,count_processing,count_hidden,count_moderation_failed,count_zero_stock,count_archived,count_delisted,last_full_sync_at_ms)
		VALUES ($1,$2::uuid,1,3,1,0,0,0,0,0,0,1)`, org, storeID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO payment_orders
		(public_id,org_id,months,amount_cents,currency,provider,status,created_by_user_id,created_at,updated_at,product,topup_microfen,operation_id,pay_url)
		VALUES ('own-recharge',$1,1,100,'CNY','stripe','pending',96311,clock_timestamp(),clock_timestamp(),'wallet_topup',100000000,'own-op','https://pay.invalid/own'),
		       ('foreign-recharge',$2,1,100,'CNY','stripe','pending',96312,clock_timestamp(),clock_timestamp(),'wallet_topup',100000000,'foreign-op','https://pay.invalid/foreign')`, org, otherOrg); err != nil {
		t.Fatal(err)
	}
	token := identityRuntimeToken(t, f.request(http.MethodPost, "/api/auth/login", `{"email":"a96311@example.invalid","password":"original-password"}`, "", "workbench-reads"))
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/ops/console/snapshot", "/api/ai/wallet"} {
		response := f.request(http.MethodGet, path, "", token, "")
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		if err := spec.CheckResponse(http.MethodGet, path, response.Code, response.Header(), response.Body.Bytes()); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if path == "/api/ops/console/snapshot" && (!strings.Contains(response.Body.String(), `"store_id":"`+storeID+`"`) || !strings.Contains(response.Body.String(), `"count_total":3`) || !strings.Contains(response.Body.String(), `"ordered_units_30d":4`)) {
			t.Fatalf("console omitted visible store: %s", response.Body.String())
		}
		if path == "/api/ai/wallet" {
			var wallet struct {
				Recharges []struct {
					PublicID string `json:"public_id"`
					State    string `json:"entry_state"`
				} `json:"recharges"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &wallet); err != nil {
				t.Fatal(err)
			}
			if len(wallet.Recharges) != 1 || wallet.Recharges[0].PublicID != "own-recharge" || wallet.Recharges[0].State != "ready" {
				t.Fatalf("wallet recharge isolation: %s", response.Body.String())
			}
		}
		f.assertClean(t)
	}
}
