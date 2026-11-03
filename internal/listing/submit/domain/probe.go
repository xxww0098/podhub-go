package domain

// Probe decision from src/listing/kernel/submission/import_reconcile_decide.rs
// at a03d735. Two agreeing absences release the offer fence. One absence is
// not proof. An unreadable probe does not advance the absence streak. Nothing
// here imports a second time.

const (
	// ImportReconcileFirstWait is the first accepted-receipt probe. Ozon
	// usually finishes an import task within seconds; 30s made a successful
	// send sit at "已提交" long after the store had the product.
	ImportReconcileFirstWait = int64(5)
	// ImportUnknownFirstWait keeps the wider window for a write whose result
	// is genuinely unknown: the import may still be in flight.
	ImportUnknownFirstWait = int64(30)
	ImportProbePassCap     = int32(8)
	probeBackoff           = int64(60)
	probeBackoffCap        = int64(900)
	// Accepted receipts use a tighter backoff: the write is already known to
	// be accepted, so read cost is the only reason to wait longer.
	acceptedProbeBackoff    = int64(15)
	acceptedProbeBackoffCap = int64(300)
	// InfoListBatch is one /v3/product/info/list request's offer count.
	InfoListBatch = 50
	// CodeReconcileStillUnknown is the eighth-pass give-up in import_reconcile.rs.
	CodeReconcileStillUnknown = "OZON_RECONCILE_STILL_UNKNOWN"
)

// Sight is one read of /v3/product/info/list for a single offer.
type Sight int

const (
	SightAbsent Sight = iota
	SightUnreadable
	SightFound
)

type Found struct {
	ProductID int64
	SKU       int64
}

// ProbeMemory is what earlier probes of this intent recorded.
type ProbeMemory struct {
	Passes      int32
	Observation string
}

// ProbeAction is what to write after one sight. Never a second import.
type ProbeAction struct {
	Kind        string
	ProductID   int64
	SKU         int64
	Passes      int32
	Observation string
	BackoffSecs int64
}

func DecideProbe(memory ProbeMemory, sight Sight, found Found) ProbeAction {
	switch sight {
	case SightFound:
		if found.ProductID > 0 {
			return ProbeAction{Kind: "accept", ProductID: found.ProductID, SKU: found.SKU}
		}
		return linger(memory, "unreadable")
	case SightAbsent:
		if memory.Observation == "absent" {
			return ProbeAction{Kind: "release", Passes: memory.Passes + 1}
		}
		return linger(memory, "absent")
	default:
		return linger(memory, "unreadable")
	}
}

func linger(memory ProbeMemory, observation string) ProbeAction {
	passes := memory.Passes + 1
	if passes >= ImportProbePassCap {
		return ProbeAction{Kind: "give_up", Passes: passes, Observation: observation}
	}
	return ProbeAction{
		Kind:        "retry",
		Passes:      passes,
		Observation: observation,
		BackoffSecs: probeBackoffSecs(memory.Passes),
	}
}

// DecideAcceptedProbe is the receipt decision for an import task Ozon already
// accepted. The write is terminal: there is no offer fence to release and no
// reason to keep a row under a 15s scan forever. Two agreeing absences stop
// the probe; eight unreadable passes give up. Neither is a failure claim.
func DecideAcceptedProbe(memory ProbeMemory, sight Sight, found Found) ProbeAction {
	switch sight {
	case SightFound:
		if found.ProductID > 0 {
			return ProbeAction{Kind: "accept", ProductID: found.ProductID, SKU: found.SKU}
		}
		return acceptedLinger(memory, "unreadable")
	case SightAbsent:
		if memory.Observation == "absent" {
			return ProbeAction{Kind: "stop", Passes: memory.Passes + 1, Observation: "absent"}
		}
		return acceptedLinger(memory, "absent")
	default:
		return acceptedLinger(memory, "unreadable")
	}
}

// AcceptedSKURetry re-reads an accepted import whose product Ozon confirmed
// before it published the SKU. It uses the accepted-receipt backoff and the
// same pass cap, so a store that never returns a SKU settles as accepted
// without inventing one.
func AcceptedSKURetry(memory ProbeMemory) ProbeAction {
	return acceptedLinger(memory, "sku_pending")
}

func acceptedLinger(memory ProbeMemory, observation string) ProbeAction {
	passes := memory.Passes + 1
	if passes >= ImportProbePassCap {
		return ProbeAction{Kind: "give_up", Passes: passes, Observation: observation}
	}
	return ProbeAction{
		Kind:        "retry",
		Passes:      passes,
		Observation: observation,
		BackoffSecs: acceptedProbeBackoffSecs(memory.Passes),
	}
}

// acceptedProbeBackoffSecs is 15s doubling, capped at 5 minutes.
func acceptedProbeBackoffSecs(passesAlreadyRecorded int32) int64 {
	exponent := passesAlreadyRecorded
	if exponent < 0 {
		exponent = 0
	}
	if exponent > 16 {
		exponent = 16
	}
	wait := acceptedProbeBackoff * (int64(1) << exponent)
	if wait > acceptedProbeBackoffCap || wait <= 0 {
		return acceptedProbeBackoffCap
	}
	return wait
}

// probeBackoffSecs matches probe_backoff_after: 60s doubling, cap 900s.
// passesAlreadyRecorded is the count before this observation.
func probeBackoffSecs(passesAlreadyRecorded int32) int64 {
	exponent := passesAlreadyRecorded
	if exponent < 0 {
		exponent = 0
	}
	if exponent > 16 {
		exponent = 16
	}
	wait := probeBackoff * (int64(1) << exponent)
	if wait > probeBackoffCap || wait <= 0 {
		return probeBackoffCap
	}
	return wait
}
