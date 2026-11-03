package contract

import "testing"

func TestRatingMatchesRustVectors(t *testing.T) {
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

func TestQuotePrepayHoldsTheCeiling(t *testing.T) {
	token := Price{
		BillingMode: ModeToken, MaxRequest: 50_000,
		Input: 40_000_000, CachedInput: 20_000_000, Output: 160_000_000, Reasoning: 160_000_000,
	}
	if got, err := token.QuotePrepay(); err != nil || got != 50_000 {
		t.Fatalf("token hold %d %v", got, err)
	}

	flat := Price{BillingMode: ModePerRequest, MaxRequest: 249, PerRequest: 249}
	if got, err := flat.QuotePrepay(); err != nil || got != 249 {
		t.Fatalf("flat hold %d %v", got, err)
	}

	overCeiling := Price{BillingMode: ModePerRequest, MaxRequest: 249, PerRequest: 250}
	if _, err := overCeiling.QuotePrepay(); err == nil {
		t.Fatal("per-request price above the ceiling accepted")
	}

	invalid := Price{BillingMode: ModeToken, MaxRequest: 0, Input: 1}
	if _, err := invalid.QuotePrepay(); err == nil {
		t.Fatal("invalid price accepted")
	}
}
