package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	opscontract "github.com/xxww0098/podhub-go/internal/ops/contract"
	opsdomain "github.com/xxww0098/podhub-go/internal/ops/domain"
	opsrepo "github.com/xxww0098/podhub-go/internal/ops/repo"
	opsservice "github.com/xxww0098/podhub-go/internal/ops/service"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestOpsStockReceiptsPersistAndReplayWithoutSendingAgain(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		err     error
		unknown bool
	}{
		{"mixed warehouse outcomes", 200, `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":8,"updated":false,"errors":[{"code":"WAREHOUSE_NOT_FOUND","message":"warehouse unavailable"}]},{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]}]}`, nil, false},
		{"missing warehouse receipt", 200, `{"result":[{"product_id":41,"offer_id":"a","warehouse_id":7,"updated":true,"errors":[]}]}`, nil, true},
		{"redirect cannot prove a write", 302, `{"result":true}`, nil, true},
		{"response interrupted after headers", 200, `{}`, errors.New("response interrupted"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user, org := insertWorkspace(t, ctx, pool, "ops-stock-"+uuid.NewString()+"@example.com", "Stock receipts")
			storePK, storeID := insertStore(t, ctx, pool, org)
			upstream := &stockReceiptSeller{status: tc.status, body: tc.body, err: tc.err}
			screen := &opsservice.Screen{
				Stores: stockReceiptStore{storePK, storeID}, Seller: upstream,
				Ledger: opsrepo.New(pool, seal.Ring{}, false, seal.DefaultSellerKeyID),
			}
			actor := opsservice.Actor{UserID: user, OrgID: org, Role: "owner"}
			op := uuid.NewString()
			request := func(id string) []byte {
				return []byte(fmt.Sprintf(`{"operation_id":%q,"store_id":%q,"request":{"kind":"stock","items":[{"product_id":41,"offer_id":"a","warehouse_id":7,"stock":5},{"product_id":41,"offer_id":"a","warehouse_id":8,"stock":6}]}}`, id, storeID))
			}
			got, fail := screen.Mutate(ctx, actor, request(op))
			if tc.unknown {
				if fail == nil || fail.Code != opscontract.CodeSellerUnknown || len(got) != 0 {
					t.Fatalf("unknown receipt surfaced as success: response=%s fail=%+v", got, fail)
				}
			} else if fail != nil {
				t.Fatal(fail)
			}
			var state string
			var status *int
			var stored []byte
			if err := pool.QueryRow(ctx, `SELECT state,response_status,response_body FROM seller_upstream_writes WHERE org_id=$1 AND store_id=$2 AND idempotency_key=$3`, org, storePK, opsdomain.ProductKey(storeID, op)).Scan(&state, &status, &stored); err != nil {
				t.Fatal(err)
			}
			if tc.unknown {
				if state != "result_unknown" || status != nil || stored != nil {
					t.Fatalf("unknown outcome was settled: state=%s status=%v receipt=%s", state, status, stored)
				}
			} else {
				var receipt struct {
					Items []struct {
						Identity  string `json:"identity"`
						Succeeded bool   `json:"succeeded"`
						Message   string `json:"message"`
					} `json:"items"`
				}
				if state != "settled" || status == nil || *status != 200 || json.Unmarshal(stored, &receipt) != nil || len(receipt.Items) != 2 || !receipt.Items[0].Succeeded || receipt.Items[1].Succeeded || receipt.Items[1].Message == "" || receipt.Items[0].Identity == receipt.Items[1].Identity {
					t.Fatalf("stored receipt lost item outcomes: state=%s status=%v receipt=%s", state, status, stored)
				}
			}
			replayed, fail := screen.Mutate(ctx, actor, request(op))
			if tc.unknown {
				if fail == nil || fail.Code != opscontract.CodeSellerUnknown || len(replayed) != 0 {
					t.Fatalf("unknown replay lost fence: response=%s fail=%+v", replayed, fail)
				}
				if _, fail := screen.Mutate(ctx, actor, request(uuid.NewString())); fail == nil || fail.Code != opscontract.CodeSellerUnknown {
					t.Fatalf("new key bypassed unresolved stock: %+v", fail)
				}
			} else if fail != nil || !bytes.Equal(got, replayed) {
				t.Fatalf("replayed receipt changed: first=%s replay=%s fail=%+v", got, replayed, fail)
			}
			if upstream.calls != 1 {
				t.Fatalf("receipt replay sent %d requests", upstream.calls)
			}
		})
	}
}

type stockReceiptStore struct {
	id   int64
	uuid string
}

func (s stockReceiptStore) Admit(context.Context, int64, int64, string, string, int64) (opscontract.Admitted, error) {
	return opscontract.Admitted{StorePK: s.id, UUID: s.uuid}, nil
}

type stockReceiptSeller struct {
	status int
	body   string
	err    error
	calls  int
}

func (*stockReceiptSeller) WritesDisabled() bool { return false }
func (s *stockReceiptSeller) Call(_ context.Context, _ opscontract.Lane, method, path string, _ []byte, _ opscontract.Secret) (int, string, error) {
	s.calls++
	if method != "POST" || path != "/v2/products/stocks" {
		return 0, "", fmt.Errorf("unexpected write %s %s", method, path)
	}
	return s.status, s.body, s.err
}
