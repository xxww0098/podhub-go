package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"github.com/xxww0098/podhub-go/internal/store/domain"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
)

type syncListCall struct {
	visibility string
	cursor     string
}

type syncPageSeller struct {
	t           *testing.T
	failure     string
	calls       []syncListCall
	detailCalls int
}

func (s *syncPageSeller) SellerRead(_ context.Context, path string, body []byte, _, _ string) (int, []byte, error) {
	s.t.Helper()
	switch path {
	case "/v3/product/list":
		var raw map[string]json.RawMessage
		var req struct {
			Filter struct {
				Visibility string `json:"visibility"`
			} `json:"filter"`
			LastID string `json:"last_id"`
			Limit  int    `json:"limit"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			s.t.Fatal(err)
		}
		if err := json.Unmarshal(body, &req); err != nil {
			s.t.Fatal(err)
		}
		if _, ok := raw["visibility"]; ok || req.Limit != 1000 || req.Filter.Visibility == "" {
			s.t.Fatalf("invalid list request: %s", body)
		}
		if _, ok := raw["last_id"]; ok != (req.LastID != "") {
			s.t.Fatalf("initial cursor must be omitted: %s", body)
		}
		s.calls = append(s.calls, syncListCall{req.Filter.Visibility, req.LastID})
		if req.Filter.Visibility == "ARCHIVED" && req.LastID == "" {
			return 200, []byte(`{"result":{"items":[],"last_id":""}}`), nil
		}
		if req.Filter.Visibility != "ALL" {
			s.t.Fatalf("unexpected filter %s", req.Filter.Visibility)
		}
		switch req.LastID {
		case "":
			return 200, []byte(`{"result":{"items":[{"product_id":101,"offer_id":"fixture-101"}],"last_id":"first"}}`), nil
		case "first":
			switch s.failure {
			case "repeated":
				return 200, []byte(`{"result":{"items":[],"last_id":"first"}}`), nil
			case "missing cursor":
				return 200, []byte(`{"result":{"items":[]}}`), nil
			case "missing items":
				return 200, []byte(`{"result":{"last_id":""}}`), nil
			}
			return 200, []byte(`{"result":{"items":[],"last_id":"second"}}`), nil
		case "second":
			return 200, []byte(`{"result":{"items":[{"product_id":202,"offer_id":"fixture-202"}],"last_id":""}}`), nil
		default:
			s.t.Fatalf("unexpected cursor %q", req.LastID)
		}
	case "/v3/product/info/list":
		var req struct {
			ProductID []string `json:"product_id"`
		}
		if err := json.Unmarshal(body, &req); err != nil || len(req.ProductID) != 1 {
			s.t.Fatalf("detail request must contain one staged product: %s (%v)", body, err)
		}
		s.detailCalls++
		switch req.ProductID[0] {
		case "101":
			return 200, []byte(`{"items":[{"id":101,"offer_id":"fixture-101"}]}`), nil
		case "202":
			return 200, []byte(`{"items":[{"id":202,"offer_id":"fixture-202"}]}`), nil
		default:
			s.t.Fatalf("unexpected detail request: %s", body)
		}
	case "/v1/analytics/data":
		return 403, []byte(`{}`), nil
	default:
		s.t.Fatalf("unexpected Seller path %q", path)
	}
	return 0, nil, fmt.Errorf("unreachable fake Seller branch")
}

func TestProductSyncPaginationProtectsUnvisitedProducts(t *testing.T) {
	for _, mode := range []string{"complete", "repeated", "missing cursor", "missing items"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			pool := migratedPool(t, ctx)
			seedMatchingLease(t, ctx, pool, "entitlement", "product sync pagination")

			const userID = int64(97821)
			const storeID = "00000000-0000-4000-8000-000000000821"
			orgID := seedCompanyOrg(t, ctx, pool, userID, "sync-pagination")
			seedCompanyMember(t, ctx, pool, orgID, userID, "owner", 1)
			seedCompanyStore(t, ctx, pool, orgID, storeID, 1, "fixture store", nil)
			var storePK int64
			if err := pool.QueryRow(ctx, `SELECT id FROM organization_stores WHERE uuid=$1::uuid`, storeID).Scan(&storePK); err != nil {
				t.Fatal(err)
			}

			kek := seal.DeriveKEK("pagination-fixture")
			nonce, ciphertext, err := seal.SealBlob(kek, seal.StoreAAD(orgID, storePK, 1), []byte("fixture-api-key"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO store_seller_credentials
                (store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext, key_fingerprint, registered_by_user_id, registered_at_ms, envelope_version)
                VALUES ($1,$2,1,'fixture-client','k1',$3,$4,$5,$6,$7,1)`, storePK, orgID, nonce, ciphertext,
				seal.Fingerprint(kek, "fixture-client", "fixture-api-key"), userID, time.Now().UnixMilli()); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE organization_stores SET credential_revision=1,client_id='fixture-client' WHERE id=$1`, storePK); err != nil {
				t.Fatal(err)
			}

			tx, err := tenantx.BeginApp(ctx, pool.Begin, orgID)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			products := []domain.SellerProduct{{ID: 202, OfferID: "fixture-202"}, {ID: 999, OfferID: "fixture-999"}}
			if api := storerepo.UpsertProductsTx(ctx, tx, orgID, storePK, storeID, products, time.Now().UnixMilli()); api != nil {
				t.Fatal(api)
			}
			if _, api := storerepo.SyncNowTx(ctx, tx, orgID, storeID, time.Now().UnixMilli(), false); api != nil {
				t.Fatal(api)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}

			queue := storerepo.Queue{Finish: queuerepo.Finish, EnqueueOn: queuerepo.EnqueueOn, Renew: queuerepo.Renew, Requeue: queuerepo.RequeueJob}
			if n, err := storerepo.SweepDueProductSync(ctx, pool, 1, false, queue); err != nil || n != 1 {
				t.Fatalf("sweep: %d, %v", n, err)
			}
			jobs, err := queuerepo.Claim(ctx, pool, storerepo.KindProductSync, "pagination-test", 1)
			if err != nil || len(jobs) != 1 {
				t.Fatalf("claim: %d, %v", len(jobs), err)
			}
			seller := &syncPageSeller{t: t, failure: mode}
			if err := storerepo.RunProductSync(ctx, pool, jobs[0], seller, seal.Ring{Primary: kek}, "k1", nil, queue); err != nil {
				t.Fatal(err)
			}

			var pass, hold string
			var complete bool
			if err := pool.QueryRow(ctx, `SELECT pass,hold,last_full_sync_at_ms IS NOT NULL FROM store_product_sync WHERE org_id=$1 AND store_id=$2::uuid`, orgID, storeID).Scan(&pass, &hold, &complete); err != nil {
				t.Fatal(err)
			}
			var laterGone, absentGone bool
			if err := pool.QueryRow(ctx, `SELECT gone_at_ms IS NOT NULL FROM store_products WHERE store_pk=$1 AND product_id=202`, storePK).Scan(&laterGone); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT gone_at_ms IS NOT NULL FROM store_products WHERE store_pk=$1 AND product_id=999`, storePK).Scan(&absentGone); err != nil {
				t.Fatal(err)
			}
			if laterGone {
				t.Fatal("a product on a later page was marked gone")
			}
			if mode == "complete" {
				want := []syncListCall{{"ALL", ""}, {"ALL", "first"}, {"ALL", "second"}, {"ARCHIVED", ""}}
				if !complete || pass != "none" || hold != "none" || !absentGone || seller.detailCalls != 2 || !reflect.DeepEqual(seller.calls, want) {
					t.Fatalf("complete=%v pass=%s hold=%s absentGone=%v details=%d calls=%v", complete, pass, hold, absentGone, seller.detailCalls, seller.calls)
				}
			} else if complete || absentGone || pass != "list_live" || hold != "backoff" || seller.detailCalls != 0 || len(seller.calls) != 2 {
				t.Fatalf("unsafe failure: complete=%v pass=%s hold=%s absentGone=%v details=%d calls=%v", complete, pass, hold, absentGone, seller.detailCalls, seller.calls)
			}
		})
	}
}
