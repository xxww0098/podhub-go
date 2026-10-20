// Package engine is the server-side home of listing rules.
//
// The matcher is the Rust functions in rust/crates/listing-tags, loaded with wazero.
// This package does not reimplement stemming, lookalike folding, or separator
// folding. A browser hint is not a pass. A wasm or rule-table failure is not
// a pass.
//
// banned_tags is a platform table. OrgID is recorded by callers for the
// tenant that owns the draft; it is not a match key and it is not sent to
// the wasm.
package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// Declarations live in contract. These aliases keep the function bodies below
// on the same names.
var (
	ErrNotPorted  = contract.ErrNotPorted
	ErrRulesStale = contract.ErrRulesStale
)

const SubmitBannedTagBehaviorChange = contract.SubmitBannedTagBehaviorChange

type (
	Input          = contract.Input
	Verdict        = contract.Verdict
	SaveVerdict    = contract.SaveVerdict
	StripVerdict   = contract.StripVerdict
	SubmitDecision = contract.SubmitDecision
)

// RulesVersion is the sha256 hex of the canonical rules JSON array
// (term, matchMode, no HTML escaping, no trailing newline).
func RulesVersion(rules []Rule) (string, error) {
	if rules == nil {
		rules = []Rule{}
	}
	raw, err := marshalJSON(rules)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// Validate reports the PATCH, AI, and pre-send results and the submit gate.
// It writes nothing. A stale rulesVersion is ErrRulesStale and is not a pass.
func Validate(ctx context.Context, engine *Engine, in Input) (Verdict, error) {
	if in.RulesVersion == "" || in.RulesVersion != in.CurrentVersion {
		return Verdict{}, ErrRulesStale
	}
	save, err := rejectSave(ctx, engine, in.Tags, in.Rules)
	if err != nil {
		return Verdict{}, err
	}
	ai, err := stripAI(ctx, engine, in.Tags, in.Rules)
	if err != nil {
		return Verdict{}, err
	}
	before, err := stripBeforeSend(ctx, engine, in.Text, in.Rules)
	if err != nil {
		return Verdict{}, err
	}
	submit, err := decideSubmit(save, before)
	if err != nil {
		return Verdict{}, err
	}
	return Verdict{Save: save, AI: ai, BeforeSend: before, Submit: submit}, nil
}

func rejectSave(ctx context.Context, engine *Engine, tags []string, rules []Rule) (SaveVerdict, error) {
	out, err := engine.Call(ctx, "partition", "", "", "", tags, rules)
	if err != nil {
		return SaveVerdict{}, err
	}
	return SaveVerdict{OK: !out.Banned, Rejected: out.Rejected, Message: out.Message}, nil
}

func stripAI(ctx context.Context, engine *Engine, tags []string, rules []Rule) (StripVerdict, error) {
	out, err := engine.Call(ctx, "partition", "", "", "", tags, rules)
	if err != nil {
		return StripVerdict{}, err
	}
	return StripVerdict{Kept: out.Kept, Rejected: out.Rejected, Message: out.Message}, nil
}

func stripBeforeSend(ctx context.Context, engine *Engine, text string, rules []Rule) (StripVerdict, error) {
	out, err := engine.Call(ctx, "strip_text", "", text, "", nil, rules)
	if err != nil {
		return StripVerdict{}, err
	}
	return StripVerdict{Text: out.Text, Rejected: out.Rejected, Message: out.Message}, nil
}

// decideSubmit refuses a payload the draft PATCH would refuse, and a text
// the pre-send strip would change. It does not strip and it does not enqueue.
// AI writeback strips with the same partition as PATCH; the tag set matches,
// and this gate rejects instead of keeping the remainder.
func decideSubmit(save SaveVerdict, before StripVerdict) (SubmitDecision, error) {
	decision := SubmitDecision{
		BehaviorChange:       SubmitBannedTagBehaviorChange,
		RustFreezeChecksTags: false,
	}
	if !save.OK {
		decision.Rejected = true
		decision.Message = save.Message
		return decision, nil
	}
	if len(before.Rejected) > 0 {
		decision.Rejected = true
		decision.Message = before.Message
	}
	return decision, nil
}
