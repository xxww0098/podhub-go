package common

// Podhub adapter. Not a copy of the surrounding files.
//
// MaxTaskDurationSeconds is relay/common/relay_utils.go line 146.
// MaxBillableToolCallCount is relay/common/tool_usage.go line 32.
// Those files also parse task bodies and count tool calls. tiered_billing.go
// and text_quota.go only need the two constants.

const MaxTaskDurationSeconds = 3600

const MaxBillableToolCallCount = 10_000
