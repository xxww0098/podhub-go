package domain

import corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"

// errSnapshotVersion keeps the domain test's error text on the same sentinel.
var errSnapshotVersion = corecontract.ErrSnapshotVersion

// Snapshot, StoredAI, and AIRuntime are the sealed integration document.
type (
	Snapshot  = corecontract.Snapshot
	StoredAI  = corecontract.StoredAI
	AIRuntime = corecontract.AIRuntime
)

// AI account purposes and the default AI runtime.
const (
	PurposeOCR             = corecontract.PurposeOCR
	PurposeImage           = corecontract.PurposeImage
	PurposeChat            = corecontract.PurposeChat
	DefaultLeaseTTLSeconds = corecontract.DefaultLeaseTTLSeconds
)

// DefaultAIRuntime is every ceiling off, a 90 second lease, public dial off.
func DefaultAIRuntime() AIRuntime { return corecontract.DefaultAIRuntime() }

// ParseStored reads the camelCase document first. A snake_case row is
// accepted and reported as legacy so the caller can seal the same snapshot
// again with camelCase names.
func ParseStored(plain []byte) (Snapshot, bool, error) {
	return corecontract.ParseStored(plain)
}
