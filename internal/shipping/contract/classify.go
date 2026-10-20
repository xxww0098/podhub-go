package contract

// AbsenceFreshMS is the proof window: 15 minutes.
const AbsenceFreshMS int64 = 15 * 60 * 1000

const (
	msgNeedProof  = "须先重新核对并证明远端不存在"
	msgProofStale = "远端不存在证明已过期，请先重新核对"
)

// Inflight is queued, submitting, or waiting.
func Inflight(status string) bool {
	return status == "queued" || status == "submitting" || status == "waiting"
}

// CanSafeContinue is the diagnostic flag. It does not look at freshness.
func CanSafeContinue(status string, remoteAbsent *int64, warehouseID *int64) bool {
	return status == "unknown" && remoteAbsent != nil && warehouseID == nil
}

// SafeError is the diagnostic sentence. Other statuses return "".
func SafeError(status string, remoteAbsent *int64) string {
	switch status {
	case "unknown":
		if remoteAbsent != nil {
			return "远端未找到同名仓库，可安全继续"
		}
		return "结果未知，尚未证明远端不存在"
	case "failed":
		return "注入已失败"
	default:
		return ""
	}
}

// ProofMessage is the safe-continue proof gate. "" means the proof is fresh.
func ProofMessage(status string, remoteAbsent *int64, warehouseID *int64, nowMS int64) string {
	if remoteAbsent == nil || warehouseID != nil || status != "unknown" || Inflight(status) {
		return msgNeedProof
	}
	if nowMS-*remoteAbsent > AbsenceFreshMS {
		return msgProofStale
	}
	return ""
}

// Method is one delivery-method row the picker reads.
type Method struct {
	ID          int64
	WarehouseID int64
	Name        string
	Express     bool
}

// PickListed prefers a known id, then the first express method on this warehouse.
// nameFilter nil accepts any name. A non-nil filter requires an exact match, including "".
// The result is an index into methods, or -1.
func PickListed(nameFilter *string, warehouseID int64, known *int64, methods []Method) int {
	if known != nil {
		for i := range methods {
			if methods[i].ID == *known {
				return i
			}
		}
	}
	for i := range methods {
		row := methods[i]
		if row.WarehouseID != warehouseID || !row.Express {
			continue
		}
		if nameFilter == nil || row.Name == *nameFilter {
			return i
		}
	}
	return -1
}
