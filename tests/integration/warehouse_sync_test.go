package integration

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	whcontract "github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
	warehouserepo "github.com/xxww0098/podhub-go/internal/warehouse/repo"
	warehousesvc "github.com/xxww0098/podhub-go/internal/warehouse/service"
)

func TestWarehouseIncompleteSyncPreservesSnapshot(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "wh-sync-"+uuid.NewString()+"@example.com", "Warehouse snapshots")
	_, store := insertNextStore(t, ctx, pool, org)
	repo := warehouserepo.New(pool)
	now := time.Now().UTC().Truncate(time.Microsecond)
	if err := repo.SaveSnapshot(ctx, org, store, whcontract.Snapshot{
		Warehouses: []whcontract.Warehouse{
			{WarehouseID: 7, Name: "主仓", Status: domain.ActiveStatus, IsRFBS: true},
			{WarehouseID: 8, Name: "备仓", Status: domain.ActiveStatus},
		},
		Methods: []whcontract.Method{{MethodID: 9, WarehouseID: 7, Name: "配送"}},
		At:      now, WriteWarehouses: true, WriteMethods: true,
	}); err != nil {
		t.Fatal(err)
	}
	houses, stamp, err := repo.ListWarehouses(ctx, org, store)
	if err != nil {
		t.Fatal(err)
	}
	methods, err := repo.ListMethods(ctx, org, store, 0)
	if err != nil {
		t.Fatal(err)
	}
	const partial = `{"warehouses":[{"warehouse_id":7,"name":"未完成","status":"created","is_rfbs":true}],"has_next":true,"cursor":"same"}`
	for _, tc := range []struct{ name, houses, methods string }{
		{"missing warehouse list", `{}`, ""},
		{"incomplete warehouse pages", partial, ""},
		{"missing delivery methods", "", `{}`},
		{"incomplete delivery methods", "", `{"delivery_methods":[],"has_next":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := warehousesvc.Service{
				DB: repo, Open: warehouseOpener{n: &atomic.Int32{}},
				Post: warehouseSyncReply{houses: tc.houses, methods: tc.methods}, Limit: warehouseSyncLimit{},
				Now: func() time.Time { return now.Add(time.Hour) },
			}
			if _, err := svc.Sync(ctx, warehousesvc.Actor{OrgID: org, UserID: user, StoreID: store, Role: "owner"}); !errors.Is(err, whcontract.Ozon()) {
				t.Fatalf("incomplete sync succeeded: %v", err)
			}
			afterHouses, afterStamp, err := repo.ListWarehouses(ctx, org, store)
			if err != nil || !reflect.DeepEqual(houses, afterHouses) || !reflect.DeepEqual(stamp, afterStamp) {
				t.Fatalf("incomplete sync changed warehouses or stamp: %+v %+v %v", afterHouses, afterStamp, err)
			}
			afterMethods, err := repo.ListMethods(ctx, org, store, 0)
			if err != nil || !reflect.DeepEqual(methods, afterMethods) {
				t.Fatalf("incomplete sync changed delivery methods: %+v %v", afterMethods, err)
			}
		})
	}
	complete := warehousesvc.Service{
		DB: repo, Open: warehouseOpener{n: &atomic.Int32{}},
		Post: warehouseSyncReply{houses: `{"warehouses":[],"has_next":false}`}, Limit: warehouseSyncLimit{},
		Now: func() time.Time { return now.Add(time.Hour) },
	}
	if _, err := complete.Sync(ctx, warehousesvc.Actor{OrgID: org, UserID: user, StoreID: store, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	afterHouses, afterStamp, err := repo.ListWarehouses(ctx, org, store)
	if err != nil || len(afterHouses) != 0 || !afterStamp.Warehouses.Equal(now.Add(time.Hour)) {
		t.Fatalf("complete empty list did not replace cache: %+v %+v %v", afterHouses, afterStamp, err)
	}
	afterMethods, err := repo.ListMethods(ctx, org, store, 0)
	if err != nil || len(afterMethods) != 0 {
		t.Fatalf("complete empty list kept stale methods: %+v %v", afterMethods, err)
	}
}

type warehouseSyncReply struct{ houses, methods string }

func (p warehouseSyncReply) Post(_ context.Context, path string, _ []byte, _, _ string) (int, []byte, error) {
	if path == domain.PathWarehouseList {
		if p.houses != "" {
			return 200, []byte(p.houses), nil
		}
		return 200, []byte(`{"warehouses":[{"warehouse_id":7,"name":"新主仓","status":"created","is_rfbs":true}],"has_next":false}`), nil
	}
	return 200, []byte(p.methods), nil
}

type warehouseSyncLimit struct{}

func (warehouseSyncLimit) Reserve(context.Context, string) error { return nil }
