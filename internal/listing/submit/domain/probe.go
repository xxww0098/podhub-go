package domain

// Probe decision from src/listing/kernel/submission/import_reconcile_decide.rs
// at a03d735. Two agreeing absences release the offer fence. One absence is
// not proof. An unreadable probe does not advance the absence streak. Nothing
// here imports a second time.

const (
	ImportReconcileFirstWait = int64(30)
	ImportProbePassCap       = int32(8)
	probeBackoff             = int64(60)
	probeBackoffCap          = int64(900)
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
