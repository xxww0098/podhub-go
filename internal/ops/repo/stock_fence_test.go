package repo

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/ops/domain"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestStockTargetFenceBlocksNewKeysWhileOutcomeIsUnknown(t *testing.T) {
	pool, ctx := parityDB(t)
	const user = 883013
	org, storeID, storeUUID := seedOpsOrg(t, ctx, pool, user, "stock-fence")
	t.Cleanup(func() { dropOpsOrg(context.Background(), pool, org, user) })
	ledger := New(pool, seal.Ring{}, false, seal.DefaultSellerKeyID)
	body := func(product, warehouse int64, offer, kind string) []byte {
		raw, err := json.Marshal(map[string]any{"kind": kind, "items": []any{map[string]any{
			"product_id": product, "offer_id": offer, "warehouse_id": warehouse, "stock": 5,
		}}})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	begin := func(key string, raw []byte) (contract.LedgerRow, error) {
		return ledger.Begin(ctx, org, storeID, key, domain.RequestHash(storeUUID, raw), contract.KindProductMutation, raw)
	}
	raw := body(41, 7, "a", "stock")
	type result struct {
		key string
		row contract.LedgerRow
		err error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for range 2 {
		key := uuid.NewString()
		go func() {
			<-start
			row, err := begin(key, raw)
			results <- result{key, row, err}
		}()
	}
	close(start)
	var winner string
	for range 2 {
		got := <-results
		if got.err == nil && got.row.Inserted {
			if winner != "" {
				t.Fatal("two operation IDs acquired the same product and warehouse")
			}
			winner = got.key
			continue
		}
		var fail *contract.Fail
		if !errors.As(got.err, &fail) || fail.Code != contract.CodeSellerUnknown {
			t.Fatalf("contending stock result: %+v err=%v", got.row, got.err)
		}
	}
	if winner == "" {
		t.Fatal("no stock operation acquired target")
	}
	if err := ledger.MarkUnknown(ctx, org, storeID, winner, domain.RequestHash(storeUUID, raw), contract.CodeSellerUnknown, "lost response", 60); err != nil {
		t.Fatal(err)
	}
	if got, err := begin(winner, raw); err != nil || got.Inserted || got.State != "result_unknown" {
		t.Fatalf("original key did not retain unknown receipt: %+v err=%v", got, err)
	}
	for _, next := range [][]byte{body(41, 7, "other-offer", "stock"), body(42, 7, " a ", "stock")} {
		_, err := begin(uuid.NewString(), next)
		var fail *contract.Fail
		if !errors.As(err, &fail) || fail.Code != contract.CodeSellerUnknown {
			t.Fatalf("unknown stock bypassed with a new key: %v", err)
		}
	}
	for _, next := range [][]byte{body(41, 8, "a", "stock"), body(42, 7, "b", "stock"), body(41, 7, "a", "price")} {
		if got, err := begin(uuid.NewString(), next); err != nil || !got.Inserted {
			t.Fatalf("unrelated mutation blocked: %+v err=%v", got, err)
		}
	}
}
