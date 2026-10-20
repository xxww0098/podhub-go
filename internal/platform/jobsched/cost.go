package jobsched

// CostUnits matches jobs/mod.rs cost_units_for_kind.
func CostUnits(kind string) int32 {
	switch kind {
	case "ai.recognize", "media.render":
		return 8
	case "listing.submit", "listing.submit.batch":
		return 4
	case "media.upload", "listing.reconcile":
		return 2
	default:
		return 1
	}
}
