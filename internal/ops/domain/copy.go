package domain

import (
	"context"
	"errors"
	"math"
	"net"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const clipRunes = 160

var zhTable = []struct{ needle, zh string }{
	{"api access disabled", "Ozon 已关闭该店铺的 API 访问：请联系 Ozon 客服开通，或在卖家后台重新生成 API Key"},
	{"api-key is deactivated", "Ozon API Key 已停用：请更换一个或重新生成后再试"},
	{"invalid api-key", "Ozon API Key 无效：请检查 Client ID / API Key 后再试"},
	{"api-key is invalid", "Ozon API Key 无效：请检查 Client ID / API Key 后再试"},
	{"only one date filter allowed", "Ozon 只允许使用一个日期筛选条件"},
	{"positive stock to archived product", "归档商品不能设置正库存"},
	{"existing subscription", "当前 Ozon 订阅套餐不包含该接口"},
	{"premium plus", "该接口仅对 Ozon Premium Plus 订阅开放"},
	{"премиум", "该接口仅对 Ozon Premium Plus 订阅开放"},
	{"period is too long", "查询时间跨度超出 Ozon 上限：请缩短时间范围"},
	{"unauthenticated", "Ozon 未通过身份认证：请检查 Client ID / API Key"},
	{"permission denied", "Ozon 拒绝访问：当前 API Key 没有该接口权限"},
	{"too many requests", "Ozon 接口调用过于频繁：请稍后再试"},
	{"product not found", "Ozon 未找到该商品"},
	{"service unavailable", "Ozon 服务暂时不可用：请稍后再试"},
}

// MessageZH is seller_api::message_zh. A string that already contains a
// CJK unified ideograph is returned unchanged.
func MessageZH(message string) string {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		return ""
	}
	for _, r := range trimmed {
		if r >= 0x4e00 && r <= 0x9fff {
			return trimmed
		}
	}
	hay := strings.ToLower(strings.ReplaceAll(trimmed, "_", " "))
	for _, row := range zhTable {
		if strings.Contains(hay, row.needle) {
			return row.zh
		}
	}
	return "Ozon 返回：" + trimmed
}

// Clip truncates to 160 Unicode scalars and adds an ellipsis.
func Clip(s string) string {
	if utf8.RuneCountInString(s) <= clipRunes {
		return s
	}
	r := []rune(s)
	return string(r[:clipRunes]) + "…"
}

// Page is one Seller round trip.
type Page struct {
	Status int
	Body   string
	Err    error
}

// Fetch reads or writes one Seller path. The caller already holds the slot.
type Fetch func(method, path string, body []byte) Page

// Egress maps a pre-HTTP failure. screen is the route's ozon_* code.
func Egress(err error, screen string) *contract.Fail {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, contract.ErrWritesDisabled):
		return contract.WritesOff()
	case errors.Is(err, contract.ErrSaturated), errors.Is(err, contract.ErrRateLimited):
		return &contract.Fail{Status: 429, Code: contract.CodeOzonRateLimited, Message: "Ozon 读取频率已达上限，请稍后重试"}
	case errors.Is(err, contract.ErrUnreachable):
		return &contract.Fail{Status: 502, Code: screen, Message: "Ozon 请求通道暂不可用，请稍后重试"}
	default:
		return &contract.Fail{Status: 502, Code: screen, Message: "Seller 凭据无法通过校验"}
	}
}

// SellerHTTP maps an Ozon status. operation is the Chinese verb in transport copy.
func SellerHTTP(status int, body, operation, path, screen string) *contract.Fail {
	if status == 401 || status == 403 {
		msg := ozonReason(body)
		if msg == "" {
			msg = "Ozon 拒绝了当前店铺凭据"
		}
		return &contract.Fail{Status: 502, Code: contract.CodeOzonAuthFailed, Message: msg}
	}
	if status == 429 {
		msg := ozonReason(body)
		if msg == "" {
			msg = "Ozon 暂时限制了读取频率"
		}
		return &contract.Fail{Status: 429, Code: contract.CodeOzonRateLimited, Message: msg}
	}
	return &contract.Fail{Status: 502, Code: screen, Message: readMessage(operation, path, status, body, nil)}
}

// Transport maps a dial or decode failure that never became an Ozon status.
func Transport(operation, path string, err error) *contract.Fail {
	return &contract.Fail{Status: 502, Code: "", Message: readMessage(operation, path, 0, "", err)}
}

func readMessage(operation, path string, status int, body string, err error) string {
	if err != nil {
		if isTimeout(err) {
			return "Ozon " + operation + "超时（" + path + "）"
		}
		if isConnect(err) {
			return "无法连接 Ozon Seller API（" + path + "）"
		}
		return "Ozon " + operation + "传输中断（" + path + "）：" + Clip(err.Error())
	}
	if msg := ozonReason(body); msg != "" && status >= 400 {
		return msg
	}
	if status != 0 {
		return "Ozon " + operation + "失败（HTTP " + itoa(status) + "）"
	}
	return "Ozon " + operation + "失败：" + Clip(strings.TrimSpace(body))
}

func ozonReason(body string) string {
	msg := jsonMessage(body)
	if strings.TrimSpace(msg) == "" {
		msg = strings.TrimSpace(body)
	}
	if msg == "" {
		return ""
	}
	return MessageZH(msg)
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func isConnect(err error) bool {
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "connection refused") || strings.Contains(s, "no such host") || strings.Contains(s, "connect")
}

func finite(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// PremiumPlus is the voice 403 capability fact. Other 403s stay auth failures.
func PremiumPlus(status int, body string) bool {
	if status != 403 {
		return false
	}
	hay := strings.ToLower(body)
	if strings.Contains(hay, "premium plus") || strings.Contains(hay, "premium-plus") || strings.Contains(hay, "premiumplus") || strings.Contains(hay, "премиум плюс") || strings.Contains(hay, "премиум-плюс") {
		return true
	}
	if strings.Contains(hay, "подписк") && (strings.Contains(hay, "premium") || strings.Contains(hay, "премиум")) {
		return true
	}
	return strings.Contains(hay, "not available with existing subscription")
}
