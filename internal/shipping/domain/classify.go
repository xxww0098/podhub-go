package domain

import "github.com/xxww0098/podhub-go/internal/shipping/contract"

// Outcome is classify_mutate.
type Outcome string

const (
	Accepted      Outcome = "accepted"
	LostAfterSend Outcome = "lost_after_send"
	Failed        Outcome = "failed"
)

// MutateKind classifies one non-retried Seller write.
// A 5xx may have landed. A 4xx, including 429, did not.
// A connect error has not been sent. Any other transport error has.
type MutateKind struct {
	OperationID string
	Status      int
	Config      bool
	Decode      bool
	Transport   bool
	Connect     bool
}

// ClassifyMutate is ozon.rs classify_mutate.
func ClassifyMutate(k MutateKind) (Outcome, string) {
	if k.Config {
		return Failed, ""
	}
	if k.Decode {
		return LostAfterSend, ""
	}
	if k.Transport {
		if k.Connect {
			return Failed, ""
		}
		return LostAfterSend, ""
	}
	if k.Status >= 200 && k.Status < 300 {
		if k.OperationID != "" {
			return Accepted, k.OperationID
		}
		return LostAfterSend, ""
	}
	if k.Status >= 500 {
		return LostAfterSend, ""
	}
	if k.Status > 0 {
		return Failed, ""
	}
	return LostAfterSend, ""
}

// AbsenceFreshMS is the proof window: 15 minutes.
const AbsenceFreshMS = contract.AbsenceFreshMS

// SafeContinueGuard is the admin_safe_continue check after the row is locked.
// Inflight is status queued, submitting, or waiting.
func SafeContinueGuard(status string, remoteAbsent *int64, warehouseID *int64, nowMS int64) error {
	msg := contract.ProofMessage(status, remoteAbsent, warehouseID, nowMS)
	if msg == "" {
		return nil
	}
	return guardError(msg)
}

type guardError string

func (e guardError) Error() string { return string(e) }

// GuardMessage returns the validation sentence, or "".
func GuardMessage(err error) string {
	g, ok := err.(guardError)
	if !ok {
		return ""
	}
	return string(g)
}

// CanSafeContinue is the diagnostic flag. It does not look at freshness.
func CanSafeContinue(status string, remoteAbsent *int64, warehouseID *int64) bool {
	return contract.CanSafeContinue(status, remoteAbsent, warehouseID)
}

// SafeError is the diagnostic sentence. Other statuses omit the field.
func SafeError(status string, remoteAbsent *int64) string {
	return contract.SafeError(status, remoteAbsent)
}

// DeliveryMethod is one row from /v2/delivery-method/list.
type DeliveryMethod struct {
	ID          int64
	Name        string
	Status      string
	WarehouseID int64
	Express     bool
}

// PickMethod prefers a known id, otherwise the express method on this warehouse.
// A preset delivery name, when set, must match.
func PickMethod(preset Preset, warehouseID int64, known *int64, methods []DeliveryMethod) *DeliveryMethod {
	listed := make([]contract.Method, len(methods))
	for i := range methods {
		listed[i] = contract.Method{
			ID: methods[i].ID, WarehouseID: methods[i].WarehouseID,
			Name: methods[i].Name, Express: methods[i].Express,
		}
	}
	var filter *string
	if preset.DeliveryMethodName != "" {
		name := preset.DeliveryMethodName
		filter = &name
	}
	i := contract.PickListed(filter, warehouseID, known, listed)
	if i < 0 {
		return nil
	}
	return &methods[i]
}

// RemoteAbsentAt writes the proof only for an unknown row with no warehouse.
func RemoteAbsentAt(status string, warehouseID *int64, proven bool, nowMS int64) *int64 {
	if proven && status == "unknown" && warehouseID == nil {
		return &nowMS
	}
	return nil
}
