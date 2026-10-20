package contract

import (
	"fmt"
	"math"
	"math/big"
	"sort"
)

// Usage is one provider usage object after cached and reasoning tokens have
// been taken out of the totals. The fields match ai_gateway::TokenUsage.
type Usage struct {
	PromptTokens              uint64
	CompletionTokens          uint64
	CachedPromptTokens        uint64
	ReasoningCompletionTokens uint64
}

// Charge is the microfen split stored on ai_requests. The four components
// sum to Total. Per-request mode stores a flat total and zero components.
type Charge struct {
	UncachedInput int64
	CachedInput   int64
	Output        int64
	Reasoning     int64
	Total         int64
}

// Price is one in-effect ai_price_schedules row.
type Price struct {
	ID          int64  `json:"id"`
	Model       string `json:"model"`
	BillingMode string `json:"billing_mode"`
	Input       int64  `json:"input_microfen_per_million"`
	CachedInput int64  `json:"cached_input_microfen_per_million"`
	Output      int64  `json:"output_microfen_per_million"`
	Reasoning   int64  `json:"reasoning_microfen_per_million"`
	PerRequest  int64  `json:"per_request_microfen"`
	MaxRequest  int64  `json:"max_request_microfen"`
}

const (
	ModeToken      = "token"
	ModePerRequest = "per_request"
	million        = 1_000_000
	halfUp         = 500_000
)

// OutputTokenCeiling is max_request × 1_000_000 ÷ max(output, reasoning).
// A non-positive rate means the hold does not bound a token count.
func OutputTokenCeiling(maxRequest, outputRate, reasoningRate int64) (uint64, bool) {
	rate := outputRate
	if reasoningRate > rate {
		rate = reasoningRate
	}
	if rate <= 0 {
		return 0, false
	}
	if maxRequest < 0 {
		maxRequest = 0
	}
	tokens := new(big.Int).Mul(new(big.Int).SetUint64(uint64(maxRequest)), big.NewInt(million))
	tokens.Div(tokens, new(big.Int).SetInt64(rate))
	if !tokens.IsUint64() {
		return math.MaxUint64, true
	}
	return tokens.Uint64(), true
}

// ChargeUsage prices one usage against this schedule.
// Token mode rounds half-up once on the weighted sum, then gives the leftover
// microfen to the lanes with the largest fractional part. Ties keep the order
// uncached input, cached input, output, reasoning.
func (p Price) ChargeUsage(usage Usage) (Charge, error) {
	if p.MaxRequest <= 0 || p.Input < 0 || p.CachedInput < 0 || p.Output < 0 || p.Reasoning < 0 || p.PerRequest < 0 {
		return Charge{}, fmt.Errorf("invalid billing price")
	}
	if p.BillingMode == ModePerRequest && p.PerRequest > 0 {
		return Charge{Total: p.PerRequest}, nil
	}
	if p.BillingMode != ModeToken || p.PerRequest != 0 {
		return Charge{}, fmt.Errorf("invalid billing price")
	}
	return newPriceTable(p).charge(usage)
}

type priceTable struct {
	input, cached, output, reasoning uint64
}

func newPriceTable(p Price) priceTable {
	return priceTable{
		input: uint64(p.Input), cached: uint64(p.CachedInput),
		output: uint64(p.Output), reasoning: uint64(p.Reasoning),
	}
}

func (t priceTable) charge(usage Usage) (Charge, error) {
	if usage.CachedPromptTokens > usage.PromptTokens || usage.ReasoningCompletionTokens > usage.CompletionTokens {
		return Charge{}, fmt.Errorf("token usage details exceed their totals")
	}
	uncached := usage.PromptTokens - usage.CachedPromptTokens
	ordinary := usage.CompletionTokens - usage.ReasoningCompletionTokens
	tokens := [4]uint64{uncached, usage.CachedPromptTokens, ordinary, usage.ReasoningCompletionTokens}
	rates := [4]uint64{t.input, t.cached, t.output, t.reasoning}
	weighted := [4]*big.Int{}
	sum := new(big.Int)
	for i := range tokens {
		weighted[i] = new(big.Int).Mul(new(big.Int).SetUint64(tokens[i]), new(big.Int).SetUint64(rates[i]))
		sum.Add(sum, weighted[i])
	}
	total := new(big.Int).Add(sum, big.NewInt(halfUp))
	total.Div(total, big.NewInt(million))
	if !total.IsUint64() {
		return Charge{}, fmt.Errorf("token charge overflow")
	}
	parts := [4]uint64{}
	partSum := uint64(0)
	fracs := [4]uint64{}
	div := big.NewInt(million)
	for i := range weighted {
		quo := new(big.Int).Quo(weighted[i], div)
		rem := new(big.Int).Rem(weighted[i], div)
		if !quo.IsUint64() || !rem.IsUint64() {
			return Charge{}, fmt.Errorf("token charge overflow")
		}
		parts[i] = quo.Uint64()
		fracs[i] = rem.Uint64()
		if partSum > math.MaxUint64-parts[i] {
			return Charge{}, fmt.Errorf("token charge overflow")
		}
		partSum += parts[i]
	}
	totalU := total.Uint64()
	if totalU < partSum {
		return Charge{}, fmt.Errorf("token charge overflow")
	}
	order := []int{0, 1, 2, 3}
	sort.SliceStable(order, func(i, j int) bool { return fracs[order[i]] > fracs[order[j]] })
	left := totalU - partSum
	for _, idx := range order {
		if left == 0 {
			break
		}
		parts[idx]++
		left--
	}
	out := Charge{
		UncachedInput: int64(parts[0]),
		CachedInput:   int64(parts[1]),
		Output:        int64(parts[2]),
		Reasoning:     int64(parts[3]),
		Total:         int64(totalU),
	}
	if uint64(out.UncachedInput) != parts[0] || out.UncachedInput+out.CachedInput+out.Output+out.Reasoning != out.Total {
		return Charge{}, fmt.Errorf("token charge overflow")
	}
	return out, nil
}
