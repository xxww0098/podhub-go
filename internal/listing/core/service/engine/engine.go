package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

type (
	Rule    = contract.Rule
	Outcome = contract.Outcome
)

// Engine runs banned-tag matching as listing-core op 20. It borrows the
// module's guest pool and owns no wasm of its own. A module error is a
// failure, not a pass.
type Engine struct {
	mod contract.Module
}

// New wraps a loaded listing-core module. The caller owns the module.
func New(mod contract.Module) *Engine { return &Engine{mod: mod} }

// The gate methods keep the nil convergence the flat-package seam used to
// have: a nil *Engine (or an Engine whose module never loaded) fails closed
// inside Call instead of panicking. The package-level functions in gate.go
// and rules.go carry the bodies.

func (e *Engine) Validate(ctx context.Context, in contract.Input) (contract.Verdict, error) {
	return Validate(ctx, e, in)
}

func (e *Engine) ForbidSave(ctx context.Context, tags []string, rules []contract.Rule) (contract.SaveDecision, error) {
	return ForbidSave(ctx, e, tags, rules)
}

func (e *Engine) StripForAI(ctx context.Context, tags []string, rules []contract.Rule) (contract.AIDecision, error) {
	return StripForAI(ctx, e, tags, rules)
}

func (e *Engine) StripBeforeSend(ctx context.Context, text string, rules []contract.Rule) (contract.SendDecision, error) {
	return StripBeforeSend(ctx, e, text, rules)
}

// Call runs one op. rules are stored terms; this function does not rewrite them.
func (e *Engine) Call(ctx context.Context, op, tag, text, term string, tags []string, rules []Rule) (Outcome, error) {
	if e == nil || e.mod == nil {
		return Outcome{}, fmt.Errorf("listing-core wasm is not loaded")
	}
	if tags == nil {
		tags = []string{}
	}
	if rules == nil {
		rules = []Rule{}
	}
	raw, err := marshalJSON(call{
		Op:    op,
		Tag:   tag,
		Tags:  tags,
		Text:  text,
		Term:  term,
		Rules: rules,
	})
	if err != nil {
		return Outcome{}, err
	}
	body, err := e.mod.Call(ctx, contract.OpBannedTags, nil, raw)
	if err != nil {
		return Outcome{}, err
	}
	var out Outcome
	if err := json.Unmarshal(body, &out); err != nil {
		return Outcome{}, fmt.Errorf("decode banned tags result: %w", err)
	}
	if out.Kept == nil {
		out.Kept = []string{}
	}
	if out.Rejected == nil {
		out.Rejected = []string{}
	}
	return out, nil
}

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

type call struct {
	Op    string   `json:"op"`
	Tag   string   `json:"tag"`
	Tags  []string `json:"tags"`
	Text  string   `json:"text"`
	Term  string   `json:"term"`
	Rules []Rule   `json:"rules"`
}
