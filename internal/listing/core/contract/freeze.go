// Package contract is the listing-core surface other units may import.
// Op numbers match listing-core-wasm dispatch. There is no wasm runtime here.
package contract

import "context"

// Op numbers are listing-core-wasm dispatch.rs.
const (
	OpSeedRow            uint32 = 1
	OpEditRow            uint32 = 2
	OpSettleRecognition  uint32 = 3
	OpDecideCandidates   uint32 = 4
	OpRecordRender       uint32 = 5
	OpRecordUpload       uint32 = 6
	OpRevalidate         uint32 = 7
	OpValuesEqual        uint32 = 8
	OpSubmitDraft        uint32 = 9
	OpSchemaRevision     uint32 = 10
	OpFreezeListing      uint32 = 11
	OpProjectSubmitDraft uint32 = 12
	OpIssueManifest      uint32 = 13
)

// Module is the freeze host. Call runs one browser op. Snapshot runs the
// host-only snapshot_from_fields export and returns the order-independent
// schema revision (display order of fields is kept). LegacyRevision is the
// same wasm hash without that sort — the revision Rust stored before this
// fix. Send accepts either.
type Module interface {
	Call(ctx context.Context, op uint32, schema, body []byte) ([]byte, error)
	Snapshot(ctx context.Context, raw []byte) ([]byte, error)
	LegacyRevision(ctx context.Context, raw []byte) (string, error)
}
