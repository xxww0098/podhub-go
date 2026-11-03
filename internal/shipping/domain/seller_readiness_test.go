package domain

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/shipping/contract"
)

func TestEvaluateSellerReadiness(t *testing.T) {
	bind := &contract.SellerBinding{SKUID: "sku", PresetID: "preset", PresetName: "测试预设", RequiredVersion: 2}
	preset := &Preset{Mode: "integrated", WeightUnit: "g"}
	pinned := int64(2)
	warehouse := int64(10)
	delivery := int64(20)
	active := "ACTIVE"
	ready := EvaluateSellerReadiness("sku", bind, preset, &contract.SellerInjection{
		PinnedVersion: &pinned, Status: "succeeded", WarehouseID: &warehouse, DeliveryID: &delivery, DeliveryStatus: &active,
	})
	if ready.Status != "ready" || !ready.InjectReady || len(ready.Reasons) != 0 {
		t.Fatalf("ready = %+v", ready)
	}
	stalePinned := int64(1)
	stale := EvaluateSellerReadiness("sku", bind, preset, &contract.SellerInjection{
		PinnedVersion: &stalePinned, Status: "succeeded", WarehouseID: &warehouse, DeliveryID: &delivery, DeliveryStatus: &active,
	})
	if stale.Status != "stale" || stale.InjectReady {
		t.Fatalf("stale = %+v", stale)
	}
	missing := EvaluateSellerReadiness("sku", nil, nil, nil)
	if missing.Status != "blocked" || len(missing.Reasons) != 1 || missing.Reasons[0] != contract.ReasonMissingBind {
		t.Fatalf("missing = %+v", missing)
	}
}
