package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/loadmode"
	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
)

const fixtureKey = "fixture-warehouse-api-key"

func TestGrantKillSwitchOpensNothing(t *testing.T) {
	db := &memDB{}
	open := &memOpen{}
	svc := Service{DB: db, Open: open, Limit: allowLimit{}, Now: fixedNow}
	_, err := svc.Grant(context.Background(), GrantInput{
		GrantWrite:     contract.GrantWrite{OrgID: 1, UserID: 2, StoreID: "11111111-1111-1111-1111-111111111111", ClientOperationID: "op", Kind: contract.KindCreate},
		WritesDisabled: true,
	})
	if !errors.Is(err, contract.WritesDisabled()) {
		t.Fatal(err)
	}
	if db.prepared != 0 || db.audits != 1 || open.n != 0 || db.saved != 0 {
		t.Fatalf("prepared %d audits %d opens %d saved %d", db.prepared, db.audits, open.n, db.saved)
	}
	db.failAudit = true
	_, err = svc.Grant(context.Background(), GrantInput{
		GrantWrite:     contract.GrantWrite{OrgID: 1, UserID: 2, Kind: contract.KindUpdate},
		WritesDisabled: true,
	})
	if !errors.Is(err, contract.WritesDisabled()) {
		t.Fatal(err)
	}
	if open.n != 0 {
		t.Fatal(open.n)
	}
}

func TestSyncNeverFallsBackToRetiredList(t *testing.T) {
	db := &memDB{}
	names := []string{"主仓", "主仓改"}
	var pass int
	post := &scriptPost{fn: func(path string, body []byte) (int, []byte) {
		switch path {
		case domain.PathWarehouseList:
			return 200, []byte(`{"warehouses":[{"warehouse_id":7,"name":"` + names[pass] + `","status":"created","is_rfbs":true}],"has_next":false}`)
		case domain.PathMethodList:
			if strings.Contains(string(body), `"status"`) || strings.Contains(string(body), `"provider_id"`) {
				t.Fatalf("method filter %s", body)
			}
			return 200, []byte(`{"has_next":false,"result":[{"id":3,"name":"快递","warehouse_id":7,"status":"DISABLED","provider_id":4}]}`)
		default:
			t.Fatalf("unexpected path %s", path)
			return 500, nil
		}
	}}
	svc := Service{DB: db, Open: &memOpen{}, Post: post, Limit: allowLimit{}, Now: fixedNow}
	actor := Actor{OrgID: 9, UserID: 4, StoreID: "11111111-1111-1111-1111-111111111111"}
	first, err := svc.Sync(context.Background(), actor)
	if err != nil || len(first.Warehouses) != 1 || len(first.Methods) != 1 {
		t.Fatal(err, first)
	}
	pass = 1
	second, err := svc.Sync(context.Background(), actor)
	if err != nil || len(second.Warehouses) != 1 || second.Warehouses[0].Name != "主仓改" {
		t.Fatal(err, second)
	}
	other := Actor{OrgID: 8, UserID: 4, StoreID: actor.StoreID}
	if _, _, err := svc.List(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	if _, ok := db.snap[keyOf(other.OrgID, other.StoreID)]; ok {
		t.Fatal("other org stored a snapshot")
	}
	got, ok := db.snap[keyOf(actor.OrgID, actor.StoreID)]
	if !ok || len(got.Warehouses) != 1 || got.Warehouses[0].Name != "主仓改" {
		t.Fatalf("%+v", got)
	}
	for _, path := range post.paths {
		if path == "/v1/warehouse/list" {
			t.Fatal(post.paths)
		}
	}
}

func TestObsoleteListDoesNotFallBack(t *testing.T) {
	db := &memDB{}
	cat := &memCat{}
	post := &scriptPost{fn: func(path string, body []byte) (int, []byte) {
		return 200, []byte(`{"code":9,"message":"obsolete method"}`)
	}}
	svc := Service{DB: db, Open: &memOpen{}, Post: post, Limit: allowLimit{}, Errors: cat, Now: fixedNow}
	_, err := svc.Sync(context.Background(), Actor{OrgID: 1, UserID: 2, StoreID: "11111111-1111-1111-1111-111111111111"})
	if !errors.Is(err, contract.Obsolete()) {
		t.Fatal(err)
	}
	if db.saved != 0 || len(post.paths) != 1 || post.paths[0] != domain.PathWarehouseList {
		t.Fatalf("saved %d paths %v", db.saved, post.paths)
	}
	if len(cat.codes) != 1 || cat.codes[0] != "9" || cat.paths[0] != domain.PathWarehouseList {
		t.Fatalf("%+v", cat)
	}
}

func TestWarehousePageCapDoesNotSave(t *testing.T) {
	db := &memDB{}
	var page int
	post := &scriptPost{fn: func(path string, body []byte) (int, []byte) {
		page++
		return 200, []byte(fmt.Sprintf(`{"warehouses":[{"warehouse_id":7,"name":"主仓","status":"created","is_rfbs":false}],"cursor":"c%d","has_next":true}`, page))
	}}
	svc := Service{DB: db, Open: &memOpen{}, Post: post, Limit: allowLimit{}, Now: fixedNow}
	_, err := svc.Sync(context.Background(), Actor{OrgID: 1, UserID: 2, StoreID: "11111111-1111-1111-1111-111111111111"})
	if !errors.Is(err, contract.Ozon()) || db.saved != 0 {
		t.Fatalf("%v saved %d", err, db.saved)
	}
	if len(post.paths) != domain.PageLimit {
		t.Fatal(len(post.paths))
	}
}

func TestLoadTestsStayOnModeR(t *testing.T) {
	if err := loadmode.Run("R"); err != nil {
		t.Fatal(err)
	}
	if err := loadmode.Run("W"); err == nil {
		t.Fatal("mode W")
	}
}

func fixedNow() time.Time { return time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC) }

type allowLimit struct{}

func (allowLimit) Reserve(context.Context, string) error { return nil }

type memOpen struct{ n int }

func (o *memOpen) Open(context.Context, int64, int64, string, string, time.Time) (string, string, error) {
	o.n++
	return "fixture-client-id", fixtureKey, nil
}

type scriptPost struct {
	mu    sync.Mutex
	paths []string
	fn    func(path string, body []byte) (int, []byte)
}

func (p *scriptPost) Post(_ context.Context, path string, body []byte, _, _ string) (int, []byte, error) {
	p.mu.Lock()
	p.paths = append(p.paths, path)
	fn := p.fn
	p.mu.Unlock()
	status, resp := fn(path, body)
	return status, resp, nil
}

type memCat struct {
	paths []string
	codes []string
}

func (c *memCat) RecordOzon(_ context.Context, _ int64, path string, _ int, code string) {
	c.paths = append(c.paths, path)
	c.codes = append(c.codes, code)
}

type memDB struct {
	mu        sync.Mutex
	snap      map[string]contract.Snapshot
	saved     int
	prepared  int
	audits    int
	failAudit bool
}

func keyOf(org int64, store string) string {
	return fmt.Sprintf("%d:%s", org, store)
}

func (d *memDB) PrepareGrant(context.Context, contract.GrantWrite) (contract.PreparedGrant, error) {
	d.prepared++
	return contract.PreparedGrant{}, contract.Unavailable()
}

func (d *memDB) AuditRefused(context.Context, int64, int64, string, string) error {
	d.audits++
	if d.failAudit {
		return contract.Unavailable()
	}
	return nil
}

func (d *memDB) ApplyReport(context.Context, contract.ReportWrite) (contract.ReportDone, error) {
	return contract.ReportDone{}, contract.Unavailable()
}

func (d *memDB) SaveSnapshot(_ context.Context, orgID int64, storeID string, snap contract.Snapshot) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.snap == nil {
		d.snap = map[string]contract.Snapshot{}
	}
	d.saved++
	d.snap[keyOf(orgID, storeID)] = snap
	return nil
}

func (d *memDB) ListWarehouses(context.Context, int64, string) ([]contract.Warehouse, contract.SyncStamp, error) {
	return nil, contract.SyncStamp{}, nil
}

func (d *memDB) GetWarehouse(context.Context, int64, string, int64) (contract.Warehouse, error) {
	return contract.Warehouse{}, contract.NotFound()
}

func (d *memDB) ListMethods(context.Context, int64, string, int64) ([]contract.Method, error) {
	return nil, nil
}

func (d *memDB) GetMethod(context.Context, int64, string, int64) (contract.Method, error) {
	return contract.Method{}, contract.NotFound()
}

func (d *memDB) ListRFBS(context.Context, int64, string) ([]contract.Warehouse, error) {
	return nil, nil
}

func (d *memDB) FindOperation(context.Context, int64, string, string) (contract.Operation, error) {
	return contract.Operation{}, contract.NotFound()
}
