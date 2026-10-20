package newapibilling

import (
	"math"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

func TestQuotaPerUnitIsNewAPI(t *testing.T) {
	if common.QuotaPerUnit != 500_000 {
		t.Fatalf("QuotaPerUnit %v", common.QuotaPerUnit)
	}
	if MicrofenPerQuota != 1 {
		t.Fatalf("scale %d", MicrofenPerQuota)
	}
	pre, settled, group, err := service.QuoteScheduled(3, 3, 0, 0, 1.25, 4, 0.5)
	if err != nil || pre != 3 || settled != 4 || group != 1 {
		t.Fatalf("builtin path pre=%d settled=%d group=%v err=%v", pre, settled, group, err)
	}
}

// Retail is the published qwen3.7-flash four-tier schedule.
func retailSchedule() Schedule {
	return Schedule{
		Model: "qwen3.7-flash", Mode: "token", MaxRequest: 50_000_000,
		Input: 40_000_000, Cached: 20_000_000, Output: 160_000_000, Reasoning: 160_000_000,
	}
}

func TestRetailTotalsMatchRating(t *testing.T) {
	cases := []struct {
		name               string
		prompt, completion int
		cached, reasoning  int
		rustTotal          int64
	}{
		{"ocr 40000/3500", 40_000, 3_500, 0, 0, 2_160_000},
		{"cache 1000/200/100", 1_000, 100, 200, 0, 52_000},
		{"prompt 3", 3, 0, 0, 0, 120},
		{"prompt 1000", 1_000, 0, 0, 0, 40_000},
	}
	s := retailSchedule()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rust, err := billing.Price{
				BillingMode: billing.ModeToken, MaxRequest: s.MaxRequest,
				Input: s.Input, CachedInput: s.Cached, Output: s.Output, Reasoning: s.Reasoning,
			}.ChargeUsage(billing.Usage{
				PromptTokens: uint64(tc.prompt), CompletionTokens: uint64(tc.completion),
				CachedPromptTokens: uint64(tc.cached), ReasoningCompletionTokens: uint64(tc.reasoning),
			})
			if err != nil {
				t.Fatal(err)
			}
			if rust.Total != tc.rustTotal {
				t.Fatalf("rating total %d want %d", rust.Total, tc.rustTotal)
			}
			got, err := QuoteSettle(s, Usage{Prompt: tc.prompt, Completion: tc.completion, Cached: tc.cached, Reasoning: tc.reasoning})
			if err != nil {
				t.Fatal(err)
			}
			if got.Microfen != rust.Total || got.Uncached != rust.UncachedInput || got.Cached != rust.CachedInput || got.Output != rust.Output || got.Reasoning != rust.Reasoning {
				t.Fatalf("formula %+v rating %+v", got, rust)
			}
			if got.Uncached+got.Cached+got.Output+got.Reasoning != got.Microfen {
				t.Fatalf("lanes %+v", got)
			}
		})
	}
}

func TestRoundingLanesMatchRating(t *testing.T) {
	s := Schedule{Mode: "token", MaxRequest: 1, Input: 500_000, Output: 500_000}
	rust, err := billing.Price{
		BillingMode: billing.ModeToken, MaxRequest: 1, Input: 500_000, Output: 500_000,
	}.ChargeUsage(billing.Usage{PromptTokens: 3, CompletionTokens: 3})
	if err != nil {
		t.Fatal(err)
	}
	got, err := QuoteSettle(s, Usage{Prompt: 3, Completion: 3})
	if err != nil {
		t.Fatal(err)
	}
	if rust.Total != 3 || got.Microfen != 3 || got.Uncached != 2 || got.Output != 1 || got.Reasoning != 0 || got.Cached != 0 {
		t.Fatalf("formula %+v rating %+v", got, rust)
	}
}

func TestReasoningRateGapIsMeasured(t *testing.T) {
	// output 200 microfen/token, reasoning 400. The copied formula has one
	// completion ratio, so reasoning is billed at the output rate.
	s := Schedule{
		Mode: "token", MaxRequest: 50_000_000,
		Input: 100_000_000, Cached: 10_000_000, Output: 200_000_000, Reasoning: 400_000_000,
	}
	rust, err := billing.Price{
		BillingMode: billing.ModeToken, MaxRequest: s.MaxRequest,
		Input: s.Input, CachedInput: s.Cached, Output: s.Output, Reasoning: s.Reasoning,
	}.ChargeUsage(billing.Usage{
		PromptTokens: 1_000, CompletionTokens: 400, CachedPromptTokens: 900, ReasoningCompletionTokens: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := QuoteSettle(s, Usage{Prompt: 1_000, Completion: 400, Cached: 900, Reasoning: 300})
	if err != nil {
		t.Fatal(err)
	}
	if rust.Total != 159_000 || got.Microfen != 99_000 {
		t.Fatalf("rating %d formula %d", rust.Total, got.Microfen)
	}
	if rust.Total-got.Microfen != 60_000 {
		t.Fatalf("gap %d", rust.Total-got.Microfen)
	}
}

func TestCacheAbovePromptIsClamped(t *testing.T) {
	s := retailSchedule()
	price := billing.Price{
		BillingMode: billing.ModeToken, MaxRequest: s.MaxRequest,
		Input: s.Input, CachedInput: s.Cached, Output: s.Output, Reasoning: s.Reasoning,
	}
	if _, err := price.ChargeUsage(billing.Usage{PromptTokens: 100, CachedPromptTokens: 150}); err == nil {
		t.Fatal("rating accepted cache above prompt")
	}
	got, err := QuoteSettle(s, Usage{Prompt: 100, Cached: 150})
	if err != nil {
		t.Fatal(err)
	}
	// base clamps to 0; cache 150 * 0.5 * model ratio 40 = 3000.
	if got.Microfen != 3_000 || got.Uncached != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestMinimumQuotaLiftIsOneMicrofen(t *testing.T) {
	// 1 token at 100_000 microfen per million. rating.go half-up is 0.
	// The copied formula rounds to 0 and lifts a billable request to 1.
	s := Schedule{Mode: "token", MaxRequest: 1, Input: 100_000, Output: 100_000}
	rust, err := billing.Price{
		BillingMode: billing.ModeToken, MaxRequest: 1, Input: 100_000, Output: 100_000,
	}.ChargeUsage(billing.Usage{PromptTokens: 1})
	if err != nil {
		t.Fatal(err)
	}
	got, err := QuoteSettle(s, Usage{Prompt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if rust.Total != 0 || got.Microfen != 1 || got.Quota != 1 {
		t.Fatalf("rating %d formula %+v", rust.Total, got)
	}
}

func TestScaleOneMinimizesTheLift(t *testing.T) {
	// Same 1-token request. A larger MicrofenPerQuota multiplies the lift.
	scales := []int64{1, 10, 100, 1000}
	best := int64(math.MaxInt64)
	bestScale := int64(0)
	for _, scale := range scales {
		m := float64(100_000) / 1_000_000 / float64(scale)
		_, quota, _, err := service.QuoteScheduled(0, 1, 0, 0, m, 1, 0)
		if err != nil {
			t.Fatal(err)
		}
		gap := int64(quota) * scale // rating total is 0
		if gap < best {
			best = gap
			bestScale = scale
		}
	}
	if bestScale != 1 || best != 1 {
		t.Fatalf("best scale %d gap %d", bestScale, best)
	}
}

func TestPerRequestFloatDrop(t *testing.T) {
	exact, _, err := service.QuoteFlat(float64(9) / common.QuotaPerUnit)
	if err != nil || exact != 9 {
		t.Fatalf("9 -> %d %v", exact, err)
	}
	dropped, _, err := service.QuoteFlat(float64(249) / common.QuotaPerUnit)
	if err != nil || dropped != 248 {
		t.Fatalf("249 -> %d %v", dropped, err)
	}
	got, err := QuoteSettle(Schedule{Mode: "per_request", PerRequest: 249, MaxRequest: 249}, Usage{})
	if err != nil || got.Microfen != 248 || got.Uncached != 0 || got.Output != 0 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestPrepayIsPromptEstimateNotCeiling(t *testing.T) {
	s := retailSchedule()
	hold, err := QuotePrepay(s, 1_000)
	if err != nil {
		t.Fatal(err)
	}
	// 1000 * 40, truncated, under the 50_000_000 ceiling.
	if hold != 40_000 {
		t.Fatalf("hold %d", hold)
	}
	capped, err := QuotePrepay(Schedule{Mode: "token", MaxRequest: 10, Input: 40_000_000, Output: 160_000_000}, 1_000)
	if err != nil || capped != 10 {
		t.Fatalf("capped %d %v", capped, err)
	}
}

func TestZeroInputOutputOnly(t *testing.T) {
	s := Schedule{Mode: "token", MaxRequest: 100, Output: 1_000_000}
	hold, err := QuotePrepay(s, 50)
	if err != nil || hold != 0 {
		t.Fatalf("hold %d %v", hold, err)
	}
	got, err := QuoteSettle(s, Usage{Prompt: 50, Completion: 4})
	if err != nil || got.Microfen != 4 || got.Output != 4 || got.Uncached != 0 {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := QuoteSettle(Schedule{Mode: "token", MaxRequest: 1, Cached: 1}, Usage{Prompt: 1}); err != ErrUnquotable {
		t.Fatalf("cached without input: %v", err)
	}
}
