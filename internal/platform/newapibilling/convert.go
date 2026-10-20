package newapibilling

import (
	"errors"
	"math"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
)

const (
	// UsingGroup is the only group this phase bills. The copied table gives
	// it ratio 1. Subscriptions are not mapped onto member seats.
	UsingGroup = "default"

	// MicrofenPerQuota is wallet microfen for one new-api quota unit.
	// common.QuotaPerUnit (500000) quota equals 1 USD, so this constant is
	// microfen-per-USD divided by 500000.
	//
	// 1 is the positive integer scale that keeps a published four-tier
	// microfen rate identical to the model ratio times 1_000_000. The
	// new-api "lift a rounded-zero billable quota to 1" step then moves the
	// wallet by 1 microfen. A larger scale multiplies that lift.
	MicrofenPerQuota int64 = 1
)

var (
	// ErrUnquotable is a schedule the copied text formula cannot represent
	// without charging a lane whose published rate is zero.
	ErrUnquotable = errors.New("newapibilling: price cannot be quoted")
	// ErrOverflow is a token count or product outside the copied int range.
	ErrOverflow = errors.New("newapibilling: token charge overflow")
)

// Schedule is one in-effect ai_price_schedules row, in microfen.
type Schedule struct {
	Model      string
	Mode       string
	Input      int64
	Cached     int64
	Output     int64
	Reasoning  int64
	PerRequest int64
	MaxRequest int64
}

// Usage is the provider usage. Reasoning is a subset of Completion.
// Cached may exceed Prompt; the copied formula clamps the base at zero.
type Usage struct {
	Prompt     int
	Completion int
	Cached     int
	Reasoning  int
}

// Settlement is the copied formula's quota plus the microfen lanes that
// sum to Microfen. Lanes follow the formula: reasoning tokens are priced
// at the output rate, because the text formula has one completion ratio.
type Settlement struct {
	Quota           int
	Microfen        int64
	Uncached        int64
	Cached          int64
	Output          int64
	Reasoning       int64
	ModelRatio      float64
	CompletionRatio float64
	CacheRatio      float64
	GroupRatio      float64
	ModelPrice      float64
	UsePrice        bool
}

// QuotePrepay is the copied pre-consume truncation, converted to microfen
// and capped by the schedule ceiling. Token mode freezes the prompt
// estimate only. A zero result is a real estimate, not a skipped hold.
func QuotePrepay(s Schedule, estimatePrompt int) (int64, error) {
	if estimatePrompt < 0 {
		return 0, ErrOverflow
	}
	switch s.Mode {
	case "per_request":
		quota, _, err := flatQuota(s.PerRequest)
		if err != nil {
			return 0, err
		}
		return capHold(quota, s.MaxRequest)
	case "token":
		m := float64(s.Input) / 1_000_000
		k, c := completionAndCache(s)
		pre, _, _, err := service.QuoteScheduled(estimatePrompt, estimatePrompt, 0, 0, m, k, c)
		if err != nil {
			return 0, err
		}
		return capHold(pre, s.MaxRequest)
	default:
		return 0, ErrUnquotable
	}
}

// QuoteSettle runs the copied settlement formula and splits the microfen
// total across the four lanes so they sum to that total.
func QuoteSettle(s Schedule, u Usage) (Settlement, error) {
	if u.Prompt < 0 || u.Completion < 0 || u.Cached < 0 || u.Reasoning < 0 {
		return Settlement{}, ErrOverflow
	}
	switch s.Mode {
	case "per_request":
		quota, group, err := flatQuota(s.PerRequest)
		if err != nil {
			return Settlement{}, err
		}
		micro, err := microfen(quota)
		if err != nil {
			return Settlement{}, err
		}
		return Settlement{
			Quota: quota, Microfen: micro, GroupRatio: group,
			ModelPrice: float64(s.PerRequest) / common.QuotaPerUnit, UsePrice: true,
		}, nil
	case "token":
		return settleToken(s, u)
	default:
		return Settlement{}, ErrUnquotable
	}
}

func settleToken(s Schedule, u Usage) (Settlement, error) {
	prompt, completion, cache := u.Prompt, u.Completion, u.Cached
	m, k, c, billPrompt, err := tokenRatios(s, prompt, completion)
	if err != nil {
		return Settlement{}, err
	}
	_, quota, group, err := service.QuoteScheduled(0, billPrompt, completion, cache, m, k, c)
	if err != nil {
		return Settlement{}, err
	}
	micro, err := microfen(quota)
	if err != nil {
		return Settlement{}, err
	}
	weights, err := laneWeights(s, u)
	if err != nil {
		return Settlement{}, err
	}
	lanes, err := splitLanes(micro, weights)
	if err != nil {
		return Settlement{}, err
	}
	return Settlement{
		Quota: quota, Microfen: micro,
		Uncached: lanes[0], Cached: lanes[1], Output: lanes[2], Reasoning: lanes[3],
		ModelRatio: m, CompletionRatio: k, CacheRatio: c, GroupRatio: group,
		ModelPrice: -1,
	}, nil
}

// tokenRatios picks the model / completion / cache ratios fed to the copied
// formula. Input rate above zero is the normal four-tier shape: completion
// ratio is output/input, so reasoning is billed at the output rate.
// A zero input rate can still be quoted when cache is free and the two
// completion lanes share one positive rate.
func tokenRatios(s Schedule, prompt, completion int) (m, k, c float64, billPrompt int, err error) {
	if s.Input > 0 {
		m = float64(s.Input) / 1_000_000
		k, c = completionAndCache(s)
		return m, k, c, prompt, nil
	}
	if s.Cached > 0 {
		return 0, 0, 0, 0, ErrUnquotable
	}
	rate, ok := singleCompletionRate(s)
	if !ok {
		return 0, 0, 0, 0, ErrUnquotable
	}
	return float64(rate) / 1_000_000, 1, 0, 0, nil
}

func singleCompletionRate(s Schedule) (int64, bool) {
	switch {
	case s.Output > 0 && (s.Reasoning == 0 || s.Reasoning == s.Output):
		return s.Output, true
	case s.Reasoning > 0 && s.Output == 0:
		return s.Reasoning, true
	default:
		return 0, false
	}
}

func completionAndCache(s Schedule) (k, c float64) {
	if s.Input <= 0 {
		return 0, 0
	}
	return float64(s.Output) / float64(s.Input), float64(s.Cached) / float64(s.Input)
}

func flatQuota(perRequest int64) (int, float64, error) {
	if perRequest <= 0 {
		return 0, 0, ErrUnquotable
	}
	return service.QuoteFlat(float64(perRequest) / common.QuotaPerUnit)
}

func microfen(quota int) (int64, error) {
	if quota < 0 {
		return 0, ErrOverflow
	}
	if MicrofenPerQuota != 0 && int64(quota) > math.MaxInt64/MicrofenPerQuota {
		return 0, ErrOverflow
	}
	return int64(quota) * MicrofenPerQuota, nil
}

func capHold(quota int, maxRequest int64) (int64, error) {
	micro, err := microfen(quota)
	if err != nil {
		return 0, err
	}
	if maxRequest > 0 && micro > maxRequest {
		return maxRequest, nil
	}
	return micro, nil
}

func laneWeights(s Schedule, u Usage) ([4]int64, error) {
	var w [4]int64
	base := u.Prompt - u.Cached
	if base < 0 {
		base = 0
	}
	ordinary := u.Completion - u.Reasoning
	reasoning := u.Reasoning
	if ordinary < 0 {
		ordinary = 0
		reasoning = u.Completion
	}
	// The copied formula prices every completion token at the output rate
	// when the input rate is positive. A different reasoning rate is the
	// gap versus rating.go, measured in convert_test.go.
	outRate := s.Output
	reasonRate := s.Output
	if s.Input <= 0 {
		if rate, ok := singleCompletionRate(s); ok {
			outRate, reasonRate = rate, rate
		}
	}
	var ok bool
	if w[0], ok = mul(base, s.Input); !ok {
		return w, ErrOverflow
	}
	if w[1], ok = mul(u.Cached, s.Cached); !ok {
		return w, ErrOverflow
	}
	if w[2], ok = mul(ordinary, outRate); !ok {
		return w, ErrOverflow
	}
	if w[3], ok = mul(reasoning, reasonRate); !ok {
		return w, ErrOverflow
	}
	return w, nil
}

func mul(tokens int, rate int64) (int64, bool) {
	if tokens < 0 || rate < 0 {
		return 0, false
	}
	if rate != 0 && int64(tokens) > math.MaxInt64/rate {
		return 0, false
	}
	return int64(tokens) * rate, true
}

// splitLanes gives the four lanes that sum to total. Floors are the
// integer microfen of each weight; the leftover follows the largest
// fractional part, ties keeping uncached, cached, output, reasoning.
func splitLanes(total int64, weights [4]int64) ([4]int64, error) {
	var lanes [4]int64
	if total < 0 {
		return lanes, ErrOverflow
	}
	const million int64 = 1_000_000
	var fracs [4]int64
	sum := int64(0)
	for i, w := range weights {
		if w < 0 {
			return lanes, ErrOverflow
		}
		lanes[i] = w / million
		fracs[i] = w % million
		if sum > math.MaxInt64-lanes[i] {
			return lanes, ErrOverflow
		}
		sum += lanes[i]
	}
	if total >= sum {
		left := total - sum
		order := fracOrder(fracs, true)
		for _, idx := range order {
			if left == 0 {
				break
			}
			lanes[idx]++
			left--
		}
		for left > 0 {
			lanes[0]++
			left--
		}
		return lanes, nil
	}
	left := sum - total
	order := fracOrder(fracs, false)
	for _, idx := range order {
		if left == 0 {
			break
		}
		take := lanes[idx]
		if take > left {
			take = left
		}
		lanes[idx] -= take
		left -= take
	}
	if left != 0 {
		return lanes, ErrOverflow
	}
	return lanes, nil
}

func fracOrder(fracs [4]int64, desc bool) []int {
	order := []int{0, 1, 2, 3}
	for i := 1; i < len(order); i++ {
		j := i
		for j > 0 {
			left, right := fracs[order[j-1]], fracs[order[j]]
			swap := left < right
			if !desc {
				swap = left > right
			}
			if !swap {
				break
			}
			order[j-1], order[j] = order[j], order[j-1]
			j--
		}
	}
	return order
}
