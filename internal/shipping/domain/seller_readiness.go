package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/shipping/contract"
)

// EvaluateSellerReadiness applies the seller visibility rules over one binding,
// its current preset payload and the store injection fact.
func EvaluateSellerReadiness(sku string, bind *contract.SellerBinding, preset *Preset, inject *contract.SellerInjection) contract.SellerReadiness {
	if bind == nil {
		return contract.SellerReadiness{SKUID: sku, Status: "blocked", Reasons: []string{contract.ReasonMissingBind}}
	}
	out := contract.SellerReadiness{SKUID: sku}
	out.PresetID = bind.PresetID
	name := bind.PresetName
	out.PresetDisplayName = &name
	required := bind.RequiredVersion
	out.RequiredVersion = &required
	reasons := []string{}
	if preset != nil {
		if preset.Mode == "non_integrated" {
			reasons = append(reasons, contract.ReasonNonIntegrated)
		}
		if preset.WeightUnit == "unpinned" && costWeights(preset) {
			reasons = append(reasons, contract.ReasonWeightUnitUnpinned)
		}
	}
	if inject == nil {
		reasons = append(reasons, contract.ReasonShopNotInjected)
		out.Status = "blocked"
		out.Reasons = reasons
		return out
	}
	if inject.PinnedVersion != nil {
		pinned := *inject.PinnedVersion
		out.PinnedVersion = &pinned
	}
	if inject.WarehouseID != nil {
		warehouse := *inject.WarehouseID
		out.WarehouseID = &warehouse
	}
	if inject.DeliveryID != nil {
		delivery := *inject.DeliveryID
		out.DeliveryMethodID = &delivery
	}
	status := parseSellerStatus(inject.Status)
	st := status
	out.InjectStatus = &st
	switch status {
	case "waiting", "queued", "submitting":
		reasons = append(reasons, contract.ReasonWaiting)
	case "unknown":
		reasons = append(reasons, contract.ReasonResultUnknown)
	case "failed":
		reasons = append(reasons, contract.ReasonFailed)
	case "succeeded":
		if inject.PinnedVersion == nil || *inject.PinnedVersion != bind.RequiredVersion {
			reasons = append(reasons, contract.ReasonStaleVersion)
		}
		active := inject.DeliveryStatus != nil && strings.EqualFold(*inject.DeliveryStatus, "ACTIVE")
		if !active {
			reasons = append(reasons, contract.ReasonDeliveryMethodNotActive)
		}
		if inject.WarehouseID == nil || inject.DeliveryID == nil {
			reasons = append(reasons, contract.ReasonShopNotInjected)
		}
	}
	out.Status = "blocked"
	if len(reasons) == 0 && status == "succeeded" {
		out.Status = "ready"
	} else if hasSellerReason(reasons, contract.ReasonStaleVersion) && !hasSellerReason(reasons, contract.ReasonWaiting) && !hasSellerReason(reasons, contract.ReasonResultUnknown) && !hasSellerReason(reasons, contract.ReasonFailed) {
		out.Status = "stale"
	}
	out.InjectReady = out.Status == "ready"
	out.Reasons = reasons
	return out
}

func parseSellerStatus(v string) string {
	switch v {
	case "queued", "submitting", "waiting", "succeeded", "failed":
		return v
	default:
		return "unknown"
	}
}

func hasSellerReason(reasons []string, want string) bool {
	for _, reason := range reasons {
		if reason == want {
			return true
		}
	}
	return false
}

func costWeights(p *Preset) bool {
	return p.DeliveryCosts != nil && (p.DeliveryCosts.MinWeight != nil || p.DeliveryCosts.MaxWeight != nil)
}
