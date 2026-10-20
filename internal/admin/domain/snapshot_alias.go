package domain

import corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"

// errSnapshotVersion keeps the domain test's error text on the same sentinel.
var errSnapshotVersion = corecontract.ErrSnapshotVersion

// Snapshot, StoredAI, and StoredBucket are the sealed integration document.
type (
	Snapshot     = corecontract.Snapshot
	StoredAI     = corecontract.StoredAI
	StoredBucket = corecontract.StoredBucket
)

// ParseStored reads the camelCase document first. A snake_case row is
// accepted and reported as legacy so the caller can seal the same snapshot
// again with camelCase names.
func ParseStored(plain []byte) (Snapshot, bool, error) {
	return corecontract.ParseStored(plain)
}
