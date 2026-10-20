package engine

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
	_ "github.com/xxww0098/podhub-go/internal/listing/core/domain"
)

func init() {
	contract.OpenEmbedded = func(ctx context.Context) (contract.Engine, error) {
		return OpenEmbedded(ctx)
	}
	contract.Open = func(ctx context.Context, wasm []byte) (contract.Engine, error) {
		return Open(ctx, wasm)
	}
	contract.RulesVersion = RulesVersion
	contract.Validate = func(ctx context.Context, eng contract.Engine, in contract.Input) (contract.Verdict, error) {
		return Validate(ctx, asEngine(eng), in)
	}
	contract.ForbidSave = func(ctx context.Context, eng contract.Engine, tags []string, rules []contract.Rule) (contract.SaveDecision, error) {
		return ForbidSave(ctx, asEngine(eng), tags, rules)
	}
	contract.StripForAI = func(ctx context.Context, eng contract.Engine, tags []string, rules []contract.Rule) (contract.AIDecision, error) {
		return StripForAI(ctx, asEngine(eng), tags, rules)
	}
	contract.StripBeforeSend = func(ctx context.Context, eng contract.Engine, text string, rules []contract.Rule) (contract.SendDecision, error) {
		return StripBeforeSend(ctx, asEngine(eng), text, rules)
	}
	contract.TagsWASMFromEnv = TagsWASMFromEnv
	contract.ProbeWASMFromEnv = ProbeWASMFromEnv
}

// asEngine recovers the concrete runtime. A nil interface and a nil pointer
// both become a nil *Engine, so Call's existing nil check still fails closed.
func asEngine(eng contract.Engine) *Engine {
	if eng == nil {
		return nil
	}
	e, ok := eng.(*Engine)
	if !ok {
		return nil
	}
	return e
}
