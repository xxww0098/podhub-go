package integration

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestShippingVerificationSettlementRollsBackTogether(t *testing.T) {
	ctx, pool, repo, store, preset := shippingReconcileFixture(t)
	now := time.Now().UnixMilli()
	if _, err := pool.Exec(ctx, `UPDATE shipping_shop_injections SET remote_absent_at_ms=$3
		WHERE store_uuid=$1::uuid AND preset_id=$2`, store, preset, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_shipping_verified_ids() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'injected shipping ID write failure'; END $$;
		CREATE TRIGGER reject_shipping_verified_ids BEFORE UPDATE OF warehouse_id,delivery_method_id ON shipping_shop_injections
		FOR EACH ROW WHEN (NEW.warehouse_id IS NOT NULL) EXECUTE FUNCTION reject_shipping_verified_ids()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS reject_shipping_verified_ids ON shipping_shop_injections;
			DROP FUNCTION IF EXISTS reject_shipping_verified_ids()`)
	})
	writes := 0
	_, err := repo.SafeContinue(ctx, store, preset, "stshipping-credential", now+1, shippingRead(func(_ context.Context, path string, _ []byte, write bool, _, _ string) (int, []byte, error) {
		if write {
			writes++
		}
		switch path {
		case "/v1/warehouse/erfbs/aggregator/create":
			return http.StatusOK, []byte(`{"operation_id":"local-settlement"}`), nil
		case "/v1/warehouse/operation/status":
			return http.StatusOK, []byte(`{"status":"SUCCESS","result":{"warehouse_id":11}}`), nil
		case "/v2/delivery-method/list":
			return http.StatusOK, []byte(`{"delivery_methods":[{"id":22,"name":"Express","status":"ACTIVE","warehouse_id":11,"is_express":true}]}`), nil
		default:
			t.Fatalf("unexpected upstream path %s", path)
			return 0, nil, nil
		}
	}))
	if err == nil || writes != 1 {
		t.Fatalf("expected local persistence failure after one write: writes=%d err=%v", writes, err)
	}
	var status, operationStatus, phase string
	var warehouse, delivery, absent *int64
	var lastOperation, operationID *string
	if err := pool.QueryRow(ctx, `SELECT i.status,i.warehouse_id,i.delivery_method_id,i.remote_absent_at_ms,i.last_ozon_operation_id,
		o.status,o.phase,o.ozon_operation_id
		FROM shipping_shop_injections i JOIN shipping_inject_operations o USING (store_uuid,preset_id)
		WHERE i.store_uuid=$1::uuid AND i.preset_id=$2`, store, preset).Scan(
		&status, &warehouse, &delivery, &absent, &lastOperation, &operationStatus, &phase, &operationID); err != nil {
		t.Fatal(err)
	}
	if status != "waiting" || operationStatus != "waiting" || phase != "create_warehouse" || warehouse != nil || delivery != nil || absent != nil ||
		lastOperation == nil || *lastOperation != "local-settlement" || operationID == nil || *operationID != "local-settlement" {
		t.Fatalf("failed verification left a partial settlement: status=%s operation=%s phase=%s warehouse=%v delivery=%v absent=%v lastOperation=%v operationID=%v",
			status, operationStatus, phase, warehouse, delivery, absent, lastOperation, operationID)
	}
}
