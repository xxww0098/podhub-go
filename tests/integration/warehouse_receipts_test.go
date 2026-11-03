package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	whcontract "github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
	warehouserepo "github.com/xxww0098/podhub-go/internal/warehouse/repo"
	warehousesvc "github.com/xxww0098/podhub-go/internal/warehouse/service"
)

func TestWarehouseUnconfirmedWritesKeepFence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	repo := warehouserepo.New(pool)
	user, org := insertWorkspace(t, ctx, pool, "wh-receipt-"+uuid.NewString()+"@example.com", "Warehouse receipts")
	now := time.Now().UTC()
	for _, kind := range []string{whcontract.KindCreate, whcontract.KindArchive, whcontract.KindUnarchive} {
		t.Run(kind, func(t *testing.T) {
			_, store := insertNextStore(t, ctx, pool, org)
			warehouseID := int64(11)
			if err := repo.SaveSnapshot(ctx, org, store, whcontract.Snapshot{
				Warehouses: []whcontract.Warehouse{{WarehouseID: warehouseID, Name: "主仓", Status: domain.ActiveStatus}},
				At:         now, WriteWarehouses: true,
			}); err != nil {
				t.Fatal(err)
			}
			archived := kind == whcontract.KindUnarchive
			if archived {
				if _, err := pool.Exec(ctx, `UPDATE ozon_warehouses SET archived_at=$3 WHERE org_id=$1 AND store_id=$2::uuid`, org, store, now); err != nil {
					t.Fatal(err)
				}
			}
			grant := whcontract.GrantWrite{OrgID: org, UserID: user, StoreID: store, ClientOperationID: "first", Kind: kind, Confirm: true, Now: now}
			if kind != whcontract.KindCreate {
				grant.WarehouseID = &warehouseID
			}
			first, err := repo.PrepareGrant(ctx, grant)
			if err != nil {
				t.Fatal(err)
			}
			grant.Now = now.Add(domain.GrantTTL + time.Second)
			grant.ClientOperationID = "retry"
			if kind == whcontract.KindCreate {
				if _, err := repo.PrepareGrant(ctx, grant); !errors.Is(err, whcontract.Busy()) {
					t.Fatalf("expired credential grant released an unconfirmed write: %v", err)
				}
			}
			status := 200
			done, err := repo.ApplyReport(ctx, whcontract.ReportWrite{
				OrgID: org, UserID: user, IntentID: first.IntentID, HTTPStatus: &status, OperationID: "pending-op", Now: grant.Now,
			})
			if err != nil || done.State != domain.StateUnknown {
				t.Fatalf("request acceptance became completion: %+v %v", done, err)
			}
			if _, err := repo.FindOperation(ctx, org, store, "pending-op"); err != nil {
				t.Fatalf("accepted operation cannot be inspected: %v", err)
			}
			got, err := repo.GetWarehouse(ctx, org, store, warehouseID)
			if err != nil || got.Archived != archived {
				t.Fatalf("unconfirmed report changed archive state: %+v %v", got, err)
			}
			if _, err := repo.PrepareGrant(ctx, grant); !errors.Is(err, whcontract.Busy()) {
				t.Fatalf("accepted but unconfirmed write released its fence: %v", err)
			}
		})
	}
}

func TestWarehouseCredentialFailureReleasesOnlyUnsentGrant(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	repo := warehouserepo.New(pool)
	user, org := insertWorkspace(t, ctx, pool, "wh-key-"+uuid.NewString()+"@example.com", "Warehouse credentials")
	for _, cancelled := range []bool{false, true} {
		name := "open failed"
		if cancelled {
			name = "request cancelled during open"
		}
		t.Run(name, func(t *testing.T) {
			_, store := insertNextStore(t, ctx, pool, org)
			attempt, cancelAttempt := context.WithCancel(ctx)
			defer cancelAttempt()
			opener := &warehouseFlakyOpener{fail: true}
			if cancelled {
				opener.cancel = cancelAttempt
			}
			svc := warehousesvc.Service{DB: repo, Open: opener, Limit: warehouseSyncLimit{}}
			in := warehousesvc.GrantInput{GrantWrite: whcontract.GrantWrite{
				OrgID: org, UserID: user, StoreID: store, ClientOperationID: "no-key", Kind: whcontract.KindCreate,
			}, Role: "owner"}
			got, err := svc.Grant(attempt, in)
			if !errors.Is(err, whcontract.CredentialUnavailable()) || got.APIKey != "" {
				t.Fatalf("failed open returned a grant: %+v %v", got, err)
			}
			opener.fail, opener.cancel = false, nil
			in.ClientOperationID = "retry"
			got, err = svc.Grant(ctx, in)
			if err != nil || got.APIKey != warehouseFixtureKey {
				t.Fatalf("unsent grant still holds the fence: %+v %v", got, err)
			}
			var state, code string
			if err := pool.QueryRow(ctx, `SELECT state,error_code FROM ozon_warehouse_intents WHERE org_id=$1 AND store_id=$2::uuid AND client_operation_id='no-key'`, org, store).Scan(&state, &code); err != nil || state != domain.StateRejected || code != "credential_unavailable" {
				t.Fatalf("unsent outcome was not persisted: state=%s code=%s err=%v", state, code, err)
			}
		})
	}
}

type warehouseFlakyOpener struct {
	fail   bool
	cancel context.CancelFunc
}

func (o *warehouseFlakyOpener) Open(context.Context, int64, int64, string, string, time.Time) (string, string, error) {
	if o.fail {
		if o.cancel != nil {
			o.cancel()
		}
		return "", "", errors.New("credential cannot be opened")
	}
	return "fixture-client-id", warehouseFixtureKey, nil
}
