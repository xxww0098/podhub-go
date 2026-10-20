package engine

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// The three call sites share one matcher. A wasm or rules failure is
// returned to the caller; none of these functions treat that as a pass.
//
//	PATCH draft: ForbidSave (partition, reject the save)
//	AI writeback: StripForAI (partition, keep the remainder)
//	before send: StripBeforeSend (text only; the frozen request hash is not rewritten here)

type (
	SaveDecision = contract.SaveDecision
	AIDecision   = contract.AIDecision
	SendDecision = contract.SendDecision
)

// ForbidSave is the row-draft PATCH refusal.
func ForbidSave(ctx context.Context, engine *Engine, tags []string, rules []Rule) (SaveDecision, error) {
	out, err := engine.Call(ctx, "partition", "", "", "", tags, rules)
	if err != nil {
		return SaveDecision{}, err
	}
	return SaveDecision{OK: !out.Banned, Rejected: out.Rejected, Message: out.Message}, nil
}

// StripForAI is the recognition writeback. It keeps tokens partition left behind.
func StripForAI(ctx context.Context, engine *Engine, tags []string, rules []Rule) (AIDecision, error) {
	out, err := engine.Call(ctx, "partition", "", "", "", tags, rules)
	if err != nil {
		return AIDecision{}, err
	}
	return AIDecision{Kept: out.Kept, Rejected: out.Rejected, Message: out.Message}, nil
}

// StripBeforeSend is the outbound scrub. It does not change a stored hash.
func StripBeforeSend(ctx context.Context, engine *Engine, text string, rules []Rule) (SendDecision, error) {
	out, err := engine.Call(ctx, "strip_text", "", text, "", nil, rules)
	if err != nil {
		return SendDecision{}, err
	}
	return SendDecision{Text: out.Text, Rejected: out.Rejected, Message: out.Message}, nil
}

// CanonicalTerm is store::canonical_term. The body lives in contract so
// listing/rules can call it without importing this package.
var CanonicalTerm = contract.CanonicalTerm

// ErrTermLength is canonical_term's refusal.
var ErrTermLength = contract.ErrTermLength
