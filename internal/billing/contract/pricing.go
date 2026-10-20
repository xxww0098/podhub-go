package contract

import (
	"strings"
	"unicode"
)

const maxThinkingBudget = 16384

// PublishRequest is one price upsert. Normalize before calling Publish.
type PublishRequest struct {
	Model       string `json:"model"`
	BillingMode string `json:"billing_mode"`
	Input       int64  `json:"input_microfen_per_million"`
	CachedInput int64  `json:"cached_input_microfen_per_million"`
	Output      int64  `json:"output_microfen_per_million"`
	Reasoning   int64  `json:"reasoning_microfen_per_million"`
	PerRequest  int64  `json:"per_request_microfen"`
	MaxRequest  int64  `json:"max_request_microfen"`
}

// Normalize applies the publish rules from src/ai/pricing.rs.
func Normalize(model string, request PublishRequest) (PublishRequest, string, bool) {
	mode := strings.TrimSpace(request.BillingMode)
	switch mode {
	case ModeToken:
		if request.MaxRequest <= 0 {
			return PublishRequest{}, "单请求预占上限必须为正数", false
		}
		if request.Input < 0 || request.CachedInput < 0 || request.Output < 0 || request.Reasoning < 0 {
			return PublishRequest{}, "价格不能为负", false
		}
		if request.Input == 0 && request.CachedInput == 0 && request.Output == 0 && request.Reasoning == 0 {
			return PublishRequest{}, "Token 计价的四项单价不能全为 0", false
		}
		if ceiling, ok := OutputTokenCeiling(request.MaxRequest, request.Output, request.Reasoning); ok && ceiling <= maxThinkingBudget {
			return PublishRequest{}, "单请求预占上限不足以支付最深思考预算（16384 个输出 token），请提高预占上限", false
		}
		request.BillingMode = ModeToken
		request.PerRequest = 0
		request.Model = model
		return request, "", true
	case ModePerRequest:
		if request.PerRequest <= 0 {
			return PublishRequest{}, "按次价格必须为正数", false
		}
		return PublishRequest{
			Model: model, BillingMode: ModePerRequest, PerRequest: request.PerRequest, MaxRequest: request.PerRequest,
		}, "", true
	default:
		return PublishRequest{}, "计费模式无效", false
	}
}

// ValidModel is the admin model id rule: 1–128 chars, no whitespace, no controls.
func ValidModel(model string) bool {
	if len(model) < 1 || len(model) > 128 {
		return false
	}
	for _, r := range model {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}
