package contract

import (
	"context"
	"errors"
)

// Rule is one enabled banned_tags row. Term is the stored canonical term.
type Rule struct {
	Term      string `json:"term"`
	MatchMode string `json:"matchMode"`
}

// Outcome is the op 20 JSON object. Field order matches the Rust struct.
type Outcome struct {
	Banned   bool     `json:"banned"`
	Kept     []string `json:"kept"`
	Rejected []string `json:"rejected"`
	Message  string   `json:"message"`
	Text     string   `json:"text"`
	Stem     string   `json:"stem"`
}

// Engine is the banned-tag surface, listing-core op 20. The concrete type lives
// in listing/core/service/engine. The gate methods are part of the surface: a
// nil module fails closed inside Call.
type Engine interface {
	Call(ctx context.Context, op, tag, text, term string, tags []string, rules []Rule) (Outcome, error)
	Validate(ctx context.Context, in Input) (Verdict, error)
	ForbidSave(ctx context.Context, tags []string, rules []Rule) (SaveDecision, error)
	StripForAI(ctx context.Context, tags []string, rules []Rule) (AIDecision, error)
	StripBeforeSend(ctx context.Context, text string, rules []Rule) (SendDecision, error)
}

// ErrTermLength is canonical_term's refusal.
var ErrTermLength = errors.New("受限词需为 1–64 个字符")

// CanonicalTerm is store::canonical_term: normalize_tag_token, then 1..=64 chars.
func CanonicalTerm(ctx context.Context, engine Engine, raw string) (string, error) {
	out, err := engine.Call(ctx, "normalize", "", raw, "", nil, nil)
	if err != nil {
		return "", err
	}
	term := out.Text
	n := 0
	for range term {
		n++
	}
	if term == "" || n > 64 {
		return "", ErrTermLength
	}
	return term, nil
}
