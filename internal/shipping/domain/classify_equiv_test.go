package domain

import "testing"

func TestPickMethodMatchesLegacy(t *testing.T) {
	methods := []DeliveryMethod{
		{ID: 7, Name: "other", Status: "NEW", WarehouseID: 1, Express: false},
		{ID: 9, Name: "Express", Status: "ACTIVE", WarehouseID: 2, Express: true},
		{ID: 4, Name: "", Status: "ACTIVE", WarehouseID: 1, Express: true},
		{ID: 3, Name: "Express", Status: "active", WarehouseID: 1, Express: true},
	}
	known := int64(7)
	missing := int64(8)
	names := []string{"", "Express", "other"}
	knowns := []*int64{nil, &known, &missing}
	for _, name := range names {
		for _, id := range knowns {
			preset := Preset{DeliveryMethodName: name}
			got := PickMethod(preset, 1, id, methods)
			want := legacyPickMethod(preset, 1, id, methods)
			if methodIndex(methods, got) != methodIndex(methods, want) {
				t.Fatalf("name %q known %v got %d want %d", name, id, methodIndex(methods, got), methodIndex(methods, want))
			}
		}
	}
}

func methodIndex(methods []DeliveryMethod, got *DeliveryMethod) int {
	if got == nil {
		return -1
	}
	for i := range methods {
		if got == &methods[i] {
			return i
		}
	}
	return -2
}

func legacyPickMethod(preset Preset, warehouseID int64, known *int64, methods []DeliveryMethod) *DeliveryMethod {
	if known != nil {
		for i := range methods {
			if methods[i].ID == *known {
				return &methods[i]
			}
		}
	}
	for i := range methods {
		m := &methods[i]
		if m.WarehouseID != warehouseID || !m.Express {
			continue
		}
		if preset.DeliveryMethodName != "" && m.Name != preset.DeliveryMethodName {
			continue
		}
		return m
	}
	return nil
}
