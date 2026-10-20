package domain

import (
	"strings"
	"unicode"
)

const (
	modeToken      = "token"
	modePerRequest = "per_request"
	maxThinking    = 16384
)

// PriceInput is a publish body after the model id is accepted.
type PriceInput struct {
	BillingMode                      string
	Input, Cached, Output, Reasoning int64
	PerRequest                       int64
	MaxRequest                       int64
}

// Price is the normalized row.
type Price struct {
	BillingMode                      string
	Input, Cached, Output, Reasoning int64
	PerRequest                       int64
	MaxRequest                       int64
}

// ValidPriceModel requires a non-empty id of at most 128 bytes without
// whitespace or control characters.
func ValidPriceModel(model string) bool {
	model = strings.TrimSpace(model)
	if model == "" || len(model) > 128 {
		return false
	}
	for _, r := range model {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// NormalizePrice applies the token and per-request rules.
// The returned message is empty when the price is usable.
func NormalizePrice(in PriceInput) (Price, string) {
	switch strings.TrimSpace(in.BillingMode) {
	case modeToken:
		if in.MaxRequest <= 0 {
			return Price{}, "单请求预占上限必须为正数"
		}
		if in.Input < 0 || in.Cached < 0 || in.Output < 0 || in.Reasoning < 0 {
			return Price{}, "价格不能为负"
		}
		if in.Input == 0 && in.Cached == 0 && in.Output == 0 && in.Reasoning == 0 {
			return Price{}, "Token 计价的四项单价不能全为 0"
		}
		if ceiling, ok := outputTokenCeiling(in.MaxRequest, in.Output, in.Reasoning); ok && ceiling <= maxThinking {
			return Price{}, "单请求预占上限不足以支付最深思考预算（16384 个输出 token），请提高预占上限"
		}
		return Price{
			BillingMode: modeToken,
			Input:       in.Input, Cached: in.Cached, Output: in.Output, Reasoning: in.Reasoning,
			PerRequest: 0, MaxRequest: in.MaxRequest,
		}, ""
	case modePerRequest:
		if in.PerRequest <= 0 {
			return Price{}, "按次价格必须为正数"
		}
		return Price{BillingMode: modePerRequest, PerRequest: in.PerRequest, MaxRequest: in.PerRequest}, ""
	default:
		return Price{}, "计费模式无效"
	}
}

func outputTokenCeiling(maxRequest, output, reasoning int64) (uint64, bool) {
	rate := output
	if reasoning > rate {
		rate = reasoning
	}
	if rate <= 0 {
		return 0, false
	}
	if maxRequest < 0 {
		maxRequest = 0
	}
	return uint64(maxRequest) * 1_000_000 / uint64(rate), true
}
