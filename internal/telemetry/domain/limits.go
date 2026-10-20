package domain

// Inbox and client-log limits from src/telemetry/capability.rs and
// src/telemetry/client_listing_logs.rs. Byte lengths are len of the UTF-8
// string, matching Rust's byte checks.
const (
	EventInboxMaxBatch            = 200
	EventInboxDeviceIDMaxBytes    = 128
	EventInboxIDMaxBytes          = 128
	EventInboxKindMaxBytes        = 128
	EventInboxPayloadMaxBytes     = 16_384
	EventInboxCreatedAtMaxBytes   = 64
	EventInboxItemMaxWireBytes    = 128 + 128 + 64 + 16384*2 + 128
	EventInboxMaxRequestBytes     = EventInboxMaxBatch*EventInboxItemMaxWireBytes + 1024
	EventInboxCommitChunk         = 20
	ClientListingLogMaxBody       = 96 * 1024
	ClientListingLogMaxRecords    = 40
	ClientListingLogWindow        = 30
	ClientListingLogWindowSeconds = 60
)

// BatchLimitMessage is the whole-request failure for more than 200 events.
func BatchLimitMessage() string {
	return "单批最多 200 条事件"
}
