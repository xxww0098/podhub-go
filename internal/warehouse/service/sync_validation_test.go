package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
)

func TestIncompleteWarehouseSyncDoesNotSave(t *testing.T) {
	const house = `{"warehouse_id":7,"name":"主仓","status":"created","is_rfbs":true}`
	for _, tc := range []struct {
		name, warehouse, methods string
	}{
		{"missing warehouses", `{}`, ""},
		{"null warehouses", `{"warehouses":null,"has_next":false}`, ""},
		{"wrong warehouses type", `{"warehouses":{},"has_next":false}`, ""},
		{"invalid warehouse row", `{"warehouses":[` + house + `,{"warehouse_id":0,"name":"损坏"}],"has_next":false}`, ""},
		{"missing warehouse cursor", `{"warehouses":[` + house + `],"has_next":true}`, ""},
		{"repeated warehouse cursor", `{"warehouses":[` + house + `],"has_next":true,"cursor":"same"}`, ""},
		{"missing methods", "", `{}`},
		{"null methods", "", `{"delivery_methods":null,"has_next":false}`},
		{"wrong methods type", "", `{"delivery_methods":{},"has_next":false}`},
		{"invalid method row", "", `{"delivery_methods":[{"id":0,"warehouse_id":7,"name":"损坏"}],"has_next":false}`},
		{"empty methods with next page", "", `{"delivery_methods":[],"has_next":true}`},
		{"missing methods cursor", "", `{"delivery_methods":[{"id":1,"warehouse_id":7,"name":"配送"}],"has_next":true}`},
		{"repeated methods cursor", "", `{"delivery_methods":[{"id":1,"warehouse_id":7,"name":"配送"}],"has_next":true,"cursor":"same"}`},
		{"wrong warehouse", "", `{"delivery_methods":[{"id":1,"warehouse_id":8,"name":"其他仓"}],"has_next":false}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &memDB{}
			post := &scriptPost{fn: func(path string, _ []byte) (int, []byte) {
				if path == domain.PathWarehouseList {
					if tc.warehouse != "" {
						return 200, []byte(tc.warehouse)
					}
					return 200, []byte(`{"warehouses":[` + house + `],"has_next":false}`)
				}
				if tc.methods != "" {
					return 200, []byte(tc.methods)
				}
				return 200, []byte(`{"delivery_methods":[],"has_next":false}`)
			}}
			svc := Service{DB: db, Open: &memOpen{}, Post: post, Limit: allowLimit{}, Now: fixedNow}
			_, err := svc.Sync(context.Background(), Actor{OrgID: 1, UserID: 2, StoreID: "11111111-1111-1111-1111-111111111111"})
			if !errors.Is(err, contract.Ozon()) || db.saved != 0 {
				t.Fatalf("incomplete snapshot persisted: err=%v saved=%d", err, db.saved)
			}
		})
	}
}

func TestDeliveryMethodCursorPagination(t *testing.T) {
	db := &memDB{}
	var calls int
	post := &scriptPost{fn: func(path string, raw []byte) (int, []byte) {
		if path == domain.PathWarehouseList {
			return 200, []byte(`{"warehouses":[{"warehouse_id":7,"name":"主仓","is_rfbs":true},{"warehouse_id":8,"name":"备仓","is_rfbs":true}],"has_next":false}`)
		}
		var request struct {
			Cursor string `json:"cursor"`
			Filter struct {
				IDs []string `json:"warehouse_ids"`
			} `json:"filter"`
			Offset *int `json:"offset"`
		}
		if err := json.Unmarshal(raw, &request); err != nil || path != domain.PathMethodList || request.Offset != nil || len(request.Filter.IDs) != 1 {
			t.Fatalf("unexpected delivery request %s: %v", raw, err)
		}
		calls++
		id := request.Filter.IDs[0]
		if id == "7" && request.Cursor == "" {
			return 200, []byte(`{"cursor":"page-2","has_next":true,"delivery_methods":[{"id":1,"warehouse_id":7,"name":"配送1"}]}`)
		}
		if id == "7" && request.Cursor == "page-2" {
			return 200, []byte(`{"has_next":false,"delivery_methods":[{"id":2,"warehouse_id":7,"name":"配送2"}]}`)
		}
		if id == "8" && request.Cursor == "" {
			return 200, []byte(`{"has_next":false,"delivery_methods":[{"id":3,"warehouse_id":8,"name":"配送3"}]}`)
		}
		t.Fatalf("cursor leaked across warehouses: %s", raw)
		return 500, nil
	}}
	svc := Service{DB: db, Open: &memOpen{}, Post: post, Limit: allowLimit{}, Now: fixedNow}
	snap, err := svc.Sync(context.Background(), Actor{OrgID: 1, UserID: 2, StoreID: "11111111-1111-1111-1111-111111111111"})
	if err != nil || calls != 3 || len(snap.Methods) != 3 || db.saved != 1 {
		t.Fatalf("pagination: calls=%d snapshot=%+v saved=%d err=%v", calls, snap, db.saved, err)
	}
}

func TestDeliveryMethodPageCapDoesNotSave(t *testing.T) {
	db := &memDB{}
	var calls int
	post := &scriptPost{fn: func(path string, _ []byte) (int, []byte) {
		if path == domain.PathWarehouseList {
			return 200, []byte(`{"warehouses":[{"warehouse_id":7,"name":"主仓","is_rfbs":true}],"has_next":false}`)
		}
		calls++
		return 200, []byte(fmt.Sprintf(`{"cursor":"page-%d","has_next":true,"delivery_methods":[{"id":%d,"warehouse_id":7,"name":"配送"}]}`, calls, calls))
	}}
	svc := Service{DB: db, Open: &memOpen{}, Post: post, Limit: allowLimit{}, Now: fixedNow}
	_, err := svc.Sync(context.Background(), Actor{OrgID: 1, UserID: 2, StoreID: "11111111-1111-1111-1111-111111111111"})
	if !errors.Is(err, contract.Ozon()) || calls != domain.PageLimit || db.saved != 0 {
		t.Fatalf("page cap: calls=%d saved=%d err=%v", calls, db.saved, err)
	}
}
