package contract

import "testing"

func TestRatingMatchesRustVectors(t *testing.T) {
	ceil, ok := OutputTokenCeiling(7_500, 0, 0)
	if ok || ceil != 0 {
		t.Fatalf("zero rate ceiling %d %v", ceil, ok)
	}
	ceil, ok = OutputTokenCeiling(50_000_000, 160_000_000, 160_000_000)
	if !ok || ceil != 312_500 {
		t.Fatalf("ceiling %d", ceil)
	}
	ceil, ok = OutputTokenCeiling(50_000_000, 100_000_000, 400_000_000)
	if !ok || ceil != 125_000 {
		t.Fatalf("reasoning ceiling %d", ceil)
	}

	retail := Price{
		BillingMode: ModeToken, MaxRequest: 50_000_000,
		Input: 40_000_000, CachedInput: 20_000_000, Output: 160_000_000, Reasoning: 160_000_000,
	}
	got, err := retail.ChargeUsage(Usage{PromptTokens: 40_000, CompletionTokens: 3_500})
	if err != nil {
		t.Fatal(err)
	}
	if got.UncachedInput != 1_600_000 || got.Output != 560_000 || got.Total != 2_160_000 || got.CachedInput != 0 || got.Reasoning != 0 {
		t.Fatalf("ocr charge %+v", got)
	}

	split := Price{
		BillingMode: ModeToken, MaxRequest: 50_000_000,
		Input: 100_000_000, CachedInput: 10_000_000, Output: 200_000_000, Reasoning: 400_000_000,
	}
	got, err = split.ChargeUsage(Usage{PromptTokens: 1_000, CompletionTokens: 400, CachedPromptTokens: 900, ReasoningCompletionTokens: 300})
	if err != nil {
		t.Fatal(err)
	}
	if got.UncachedInput != 10_000 || got.CachedInput != 9_000 || got.Output != 20_000 || got.Reasoning != 120_000 || got.Total != 159_000 {
		t.Fatalf("detail charge %+v", got)
	}

	round := Price{BillingMode: ModeToken, MaxRequest: 1, Input: 500_000, Output: 500_000}
	got, err = round.ChargeUsage(Usage{PromptTokens: 3, CompletionTokens: 3})
	if err != nil {
		t.Fatal(err)
	}
	if got.UncachedInput != 2 || got.Output != 1 || got.Total != 3 {
		t.Fatalf("rounding %+v", got)
	}

	flat := Price{BillingMode: ModePerRequest, MaxRequest: 9, PerRequest: 9}
	got, err = flat.ChargeUsage(Usage{PromptTokens: 100, CompletionTokens: 100})
	if err != nil || got.Total != 9 || got.UncachedInput != 0 || got.Output != 0 {
		t.Fatalf("flat %+v %v", got, err)
	}
	if _, err := split.ChargeUsage(Usage{PromptTokens: 1, CachedPromptTokens: 2}); err == nil {
		t.Fatal("inconsistent usage accepted")
	}
}
