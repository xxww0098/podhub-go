package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/ops/domain"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestPromotionAndPriceShareUnknownTargetFence(t *testing.T) {
	pool, ctx := parityDB(t)
	const user = 883014
	org, store, storeUUID := seedOpsOrg(t, ctx, pool, user, "promotion-fence")
	t.Cleanup(func() { dropOpsOrg(context.Background(), pool, org, user) })
	ledger := New(pool, seal.Ring{}, false, seal.DefaultSellerKeyID)
	body := func(kind string, id, action int64, offer string) []byte {
		request := map[string]any{"kind": kind, "action_id": action}
		if kind == "promotion_leave" {
			request["product_ids"] = []int64{id}
			request["exit_prices"] = []any{map[string]any{"product_id": id, "exit_price": "80.00"}}
		} else {
			request["items"] = []any{map[string]any{"product_id": id, "offer_id": offer}}
		}
		raw, _ := json.Marshal(request)
		return raw
	}
	begin := func(key string, raw []byte) (contract.LedgerRow, error) {
		return ledger.Begin(ctx, org, store, key, domain.RequestHash(storeUUID, raw), contract.KindProductMutation, raw)
	}
	for n, prior := range []string{"price", "promotion_join", "promotion_leave"} {
		id := int64(41 + n*10)
		offer := fmt.Sprint(id)
		raw, key := body(prior, id, 7, offer), uuid.NewString()
		if row, err := begin(key, raw); err != nil || !row.Inserted {
			t.Fatalf("begin %s: %+v %v", prior, row, err)
		}
		if err := ledger.MarkUnknown(ctx, org, store, key, domain.RequestHash(storeUUID, raw), contract.CodeSellerUnknown, "interrupted", 60); err != nil {
			t.Fatal(err)
		}
		if row, err := begin(key, raw); err != nil || row.Inserted || row.State != "result_unknown" {
			t.Fatalf("unknown replay %+v %v", row, err)
		}
		for _, kind := range []string{"price", "promotion_join", "promotion_leave"} {
			_, err := begin(uuid.NewString(), body(kind, id, 8, offer))
			var fail *contract.Fail
			if !errors.As(err, &fail) || fail.Code != contract.CodeSellerUnknown {
				t.Fatalf("%s bypassed pending %s: %v", kind, prior, err)
			}
		}
		if prior != "promotion_leave" {
			if _, err := begin(uuid.NewString(), body("price", id+1, 8, " "+offer+" ")); err == nil {
				t.Fatal("matching offer bypassed unknown product")
			}
		}
		if row, err := begin(uuid.NewString(), body("promotion_join", id+2, 8, offer+"other")); err != nil || !row.Inserted {
			t.Fatalf("unrelated product blocked: %+v %v", row, err)
		}
	}
}

func TestPriceAndPromotionConcurrentAdmissionAndSettledReplay(t *testing.T) {
	pool, ctx := parityDB(t)
	const user = 883015
	org, store, storeUUID := seedOpsOrg(t, ctx, pool, user, "promotion-concurrency")
	t.Cleanup(func() { dropOpsOrg(context.Background(), pool, org, user) })
	ledger := New(pool, seal.Ring{}, false, seal.DefaultSellerKeyID)
	begin := func(key string, body []byte) (contract.LedgerRow, error) {
		return ledger.Begin(ctx, org, store, key, domain.RequestHash(storeUUID, body), contract.KindProductMutation, body)
	}
	price := []byte(`{"kind":"price","items":[{"product_id":41,"offer_id":"41"}]}`)
	settledKey := uuid.NewString()
	if _, err := begin(settledKey, price); err != nil {
		t.Fatal(err)
	}
	if err := ledger.Settle(ctx, org, store, settledKey, domain.RequestHash(storeUUID, price), 200, []byte(`{"items":[]}`)); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		row contract.LedgerRow
		err error
	}
	results, start := make(chan outcome, 2), make(chan struct{})
	for _, body := range [][]byte{price, []byte(`{"kind":"promotion_leave","action_id":8,"product_ids":[41],"exit_prices":[{"product_id":41,"exit_price":"80.00"}]}`)} {
		go func(raw []byte) { <-start; row, err := begin(uuid.NewString(), raw); results <- outcome{row, err} }(body)
	}
	close(start)
	winners := 0
	for range 2 {
		result := <-results
		if result.err == nil && result.row.Inserted {
			winners++
			continue
		}
		var fail *contract.Fail
		if !errors.As(result.err, &fail) || fail.Code != contract.CodeSellerUnknown {
			t.Fatalf("unexpected contention %+v %v", result.row, result.err)
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent price/promotion acquired %d targets", winners)
	}
	if row, err := begin(settledKey, price); err != nil || row.Inserted || row.State != "settled" {
		t.Fatalf("pending later write blocked settled replay: %+v %v", row, err)
	}
}
