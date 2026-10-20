package contract

import (
	"context"
	"errors"
)

// ErrNotPorted means the rest of submit (enqueue, freeze persistence, Seller)
// did not run. Callers must not treat that as a submitted listing.
var ErrNotPorted = errors.New("listing submit is not ported; no job was enqueued")

// ErrRulesStale means the client judged with a rules payload this process
// no longer serves.
var ErrRulesStale = errors.New("rules version is stale")

// SubmitBannedTagBehaviorChange marks the submit gate Rust's
// build→validate→freeze does not run. See docs/parity/listing-core-host.md.
const SubmitBannedTagBehaviorChange = "submit_banned_tag_gate"

// SearchTagsAttributeID is listing_core::SEARCH_TAGS_ATTRIBUTE_ID (23171).
const SearchTagsAttributeID int64 = 23171

// Input is a side-effect-free tag check. Rules come from the caller; this
// function does not read a database.
type Input struct {
	OrgID          int64
	RulesVersion   string
	CurrentVersion string
	Tags           []string
	Text           string
	Rules          []Rule
}

// Verdict is what the three existing Rust sites would do with one payload,
// plus the submit gate this port adds.
type Verdict struct {
	Save       SaveVerdict
	AI         StripVerdict
	BeforeSend StripVerdict
	Submit     SubmitDecision
}

// SaveVerdict is PATCH /api/listing/rows/{id} (rows/banned.rs + forbid_tags):
// a rejected token refuses the save. Nothing is stripped.
type SaveVerdict struct {
	OK       bool
	Rejected []string
	Message  string
}

// StripVerdict is a removal. AI writeback keeps Kept (strip_tags). Pre-send
// scrub keeps Text (strip_tag_text) and drops Rejected.
type StripVerdict struct {
	Kept     []string
	Rejected []string
	Text     string
	Message  string
}

// SubmitDecision is the new gate. RustFreezeChecksTags is false: today's
// Rust submit_drafts_pipeline does not call forbid_tags or strip inside
// build→validate→freeze.
type SubmitDecision struct {
	Rejected             bool
	Message              string
	BehaviorChange       string
	RustFreezeChecksTags bool
}

// SaveDecision is forbid_tags. OK is false when any token is rejected.
type SaveDecision struct {
	OK       bool
	Rejected []string
	Message  string
}

// AIDecision is strip_tags. Kept is what a writeback may store.
type AIDecision struct {
	Kept     []string
	Rejected []string
	Message  string
}

// SendDecision is strip_tag_text. Text is the outbound value. The caller
// must not write it back onto the frozen row.
type SendDecision struct {
	Text     string
	Rejected []string
	Message  string
}

// Funcs below are assigned by listing/core/service/engine (and domain, for
// SearchTagTokens) in init. Callers go through the flat listing package,
// which reads these variables at call time.
var (
	OpenEmbedded     func(ctx context.Context) (Engine, error)
	Open             func(ctx context.Context, wasm []byte) (Engine, error)
	RulesVersion     func(rules []Rule) (string, error)
	Validate         func(ctx context.Context, engine Engine, in Input) (Verdict, error)
	ForbidSave       func(ctx context.Context, engine Engine, tags []string, rules []Rule) (SaveDecision, error)
	StripForAI       func(ctx context.Context, engine Engine, tags []string, rules []Rule) (AIDecision, error)
	StripBeforeSend  func(ctx context.Context, engine Engine, text string, rules []Rule) (SendDecision, error)
	SearchTagTokens  func(schemaFields, draft []byte) ([]string, error)
	TagsWASMFromEnv  func() ([]byte, error)
	ProbeWASMFromEnv func() ([]byte, error)
)
