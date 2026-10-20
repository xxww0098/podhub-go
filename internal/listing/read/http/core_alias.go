package readhttp

import "github.com/xxww0098/podhub-go/internal/listing/core/contract"

// The flat listing package re-exports the same contract names. Handlers and
// httpapi keep calling them unqualified or as listing.X.
type (
	Engine         = contract.Engine
	Rule           = contract.Rule
	Outcome        = contract.Outcome
	Input          = contract.Input
	Verdict        = contract.Verdict
	SaveVerdict    = contract.SaveVerdict
	StripVerdict   = contract.StripVerdict
	SubmitDecision = contract.SubmitDecision
	SaveDecision   = contract.SaveDecision
	AIDecision     = contract.AIDecision
	SendDecision   = contract.SendDecision
	CoreError      = contract.CoreError
)

const (
	SubmitBannedTagBehaviorChange = contract.SubmitBannedTagBehaviorChange
	SearchTagsAttributeID         = contract.SearchTagsAttributeID
	CodeDecode                    = contract.CodeDecode
	CodeSchemaHandle              = contract.CodeSchemaHandle
	CodeRefused                   = contract.CodeRefused
)

var (
	ErrNotPorted       = contract.ErrNotPorted
	ErrRulesStale      = contract.ErrRulesStale
	ErrTermLength      = contract.ErrTermLength
	CanonicalTerm      = contract.CanonicalTerm
	OpenEmbedded       = contract.OpenEmbedded
	Open               = contract.Open
	RulesVersion       = contract.RulesVersion
	Validate           = contract.Validate
	ForbidSave         = contract.ForbidSave
	StripForAI         = contract.StripForAI
	StripBeforeSend    = contract.StripBeforeSend
	SearchTagTokens    = contract.SearchTagTokens
	TagsWASMFromEnv    = contract.TagsWASMFromEnv
	ProbeWASMFromEnv   = contract.ProbeWASMFromEnv
	OpSeedRow          = contract.OpSeedRow
	OpEditRow          = contract.OpEditRow
	OpDecideCandidates = contract.OpDecideCandidates
	AsCoreError        = contract.AsCoreError
)

// Core is the listing-core wasm host. Nil fails a seed or edit closed.
type Core = contract.Module
