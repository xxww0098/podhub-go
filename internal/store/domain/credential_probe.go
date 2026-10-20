package domain

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/store/contract"
)

// ProbeOutcome is how one POST /v1/roles round trip classified.
type ProbeOutcome struct {
	// Verified is true only when Ozon itself answered 2xx.
	Verified bool
	// Reason is the operator-facing sentence for a refusal. Empty on success.
	Reason string
	// Code is the durable failure code; empty on success.
	Code string
}

// ClassifyProbe maps one credential probe to its durable outcome.
//
// Ozon answers an invalid Api-Key on /v1/roles with 404 and "code 5: Invalid
// Api-Key", not 401, so the classification is "Ozon answered about this
// credential" rather than an allowlist of statuses: any 4xx is the key's
// fault, only silence, a rate limit, or Ozon's own 5xx are not.
func ClassifyProbe(status int, body []byte) ProbeOutcome {
	switch {
	case status >= 200 && status < 300:
		return ProbeOutcome{Verified: true}
	case status == 0 || status == 429 || status >= 500:
		return ProbeOutcome{
			Code:   FailureRequestFailed,
			Reason: contract.MsgVerifyUpstream,
		}
	}
	if reason := OzonReason(body); reason != "" {
		return ProbeOutcome{Code: FailureAuthRejected, Reason: reason}
	}
	return ProbeOutcome{Code: FailureAuthRejected, Reason: contract.MsgCredentialRejected}
}

// ParseRolesExpiry reads `expires_at` from a /v1/roles body. Empty or
// unparseable means the key predates Ozon's time-limited-key policy: there is
// no expiry to show, which is not a probe failure.
func ParseRolesExpiry(body []byte) *int64 {
	var root struct {
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(root.ExpiresAt)
	if trimmed == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return nil
	}
	ms := parsed.UnixMilli()
	return &ms
}

// OzonReason extracts Ozon's own refusal sentence from an error body and
// renders it in Chinese. It never returns the Api-Key: the body carries a
// message, not credentials, and a body without one yields "".
func OzonReason(body []byte) string {
	var root struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return ""
	}
	return TranslateOzonMessage(root.Message)
}

// TranslateOzonMessage is seller_api::message_zh. A message that already
// carries Chinese passes through unchanged; otherwise an exact known refusal
// maps to its Chinese copy, and anything else is prefixed rather than
// guessed at.
func TranslateOzonMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return ""
	}
	for _, r := range message {
		if r >= '一' && r <= '鿿' {
			return message
		}
	}
	haystack := strings.ReplaceAll(strings.ToLower(message), "_", " ")
	for _, pair := range ozonMessagesZH {
		if strings.Contains(haystack, pair[0]) {
			return pair[1]
		}
	}
	return "Ozon 返回：" + message
}

// ozonMessagesZH is the refusal table, longest first so the most specific
// needle wins. Only sentences operators actually act on are listed.
var ozonMessagesZH = [][2]string{
	{"api-key is deactivated", "Ozon API Key 已停用：请更换一个或重新生成后再试"},
	{"api-key is invalid", "Ozon API Key 无效：请检查 Client ID / API Key 后再试"},
	{"invalid api-key", "Ozon API Key 无效：请检查 Client ID / API Key 后再试"},
	{"api key is invalid", "Ozon API Key 无效：请检查 Client ID / API Key 后再试"},
	{"client-id is invalid", "Ozon Client ID 无效：请检查 Client ID / API Key 后再试"},
	{"invalid client-id", "Ozon Client ID 无效：请检查 Client ID / API Key 后再试"},
	{"permission denied", "该 API Key 没有此操作的权限"},
	{"forbidden", "该 API Key 没有此操作的权限"},
}
