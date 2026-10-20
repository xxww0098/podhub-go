package service

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
)

const (
	toolActivation = "generateActivationCodes"
	toolQuota      = "generateQuotaCards"
	toolListCodes  = "listRedeemCodes"

	// stepUpRequired is the grant-path refusal. A grant has no TOTP step-up,
	// so it cannot mint codes. The sentence does not depend on whether a code exists.
	stepUpRequired = "管理操作需要超级管理员会话并完成二次验证"
	msgUnavailable = "服务暂不可用"
)

// CodeAdmin is the existing admin issuer. Implementations must reuse the
// admin redeem service, including its audit row and its step-up gate.
type CodeAdmin interface {
	CreateActivation(ctx context.Context, caller domain.Caller, raw json.RawMessage) (json.RawMessage, error)
	CreateQuota(ctx context.Context, caller domain.Caller, raw json.RawMessage) (json.RawMessage, error)
	ListCodes(ctx context.Context, caller domain.Caller, raw json.RawMessage) (json.RawMessage, error)
}

// CodeError is a tool refusal. Message is safe to return; it must not contain a code.
type CodeError struct {
	Code    string
	Message string
}

func (e *CodeError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func adminTool(name string) bool {
	switch name {
	case toolActivation, toolQuota, toolListCodes:
		return true
	default:
		return false
	}
}

func decodeToolCall(params json.RawMessage) (string, json.RawMessage, bool) {
	if len(params) == 0 {
		return "", nil, false
	}
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(params, &call) != nil || call.Name == "" {
		return "", nil, false
	}
	return call.Name, call.Arguments, true
}

func (s *Service) adminTool(ctx context.Context, id json.RawMessage, name string, args json.RawMessage, session bool, caller domain.Caller) []byte {
	if !session {
		return toolRefusal(id, domain.NewHost("forbidden", stepUpRequired))
	}
	if s == nil || s.codes == nil {
		return toolRefusal(id, domain.NewHost("internal", msgUnavailable))
	}
	var (
		raw json.RawMessage
		err error
	)
	switch name {
	case toolActivation:
		raw, err = s.codes.CreateActivation(ctx, caller, args)
	case toolQuota:
		raw, err = s.codes.CreateQuota(ctx, caller, args)
	default:
		raw, err = s.codes.ListCodes(ctx, caller, args)
	}
	if err != nil {
		var coded *CodeError
		if ok := asCode(err, &coded); ok && coded.Message != "" {
			return toolRefusal(id, domain.NewHost(coded.Code, coded.Message))
		}
		slog.Error("mcp admin code tool failed")
		return toolRefusal(id, domain.NewHost("internal", msgUnavailable))
	}
	if len(raw) == 0 || !json.Valid(raw) {
		return toolRefusal(id, domain.NewHost("internal", msgUnavailable))
	}
	text := "已生成，明文仅在本次结果中"
	if name == toolListCodes {
		text = "已返回列表，不含明文码"
	}
	return toolOK(id, raw, text, false)
}

func asCode(err error, dest **CodeError) bool {
	coded, ok := err.(*CodeError)
	if !ok || coded == nil {
		return false
	}
	*dest = coded
	return true
}

const codeInputSchema = `{"type":"object","properties":{"member_seats":{"type":"integer","description":"成员名额。激活码为 1-20，额度卡传 0"},"tier":{"type":"string","description":"档位：pro、max、ultra。额度卡可省略"},"ocr_credits":{"type":"integer","description":"必须为 0，识别额度已停止发放"},"wallet_cents":{"type":"integer","description":"额度卡面额，单位分"},"quantity":{"type":"integer","description":"数量，1-500"},"duration_days":{"type":"integer","description":"激活码有效天数。额度卡沿用管理端字段，入库时固定为 1"},"expires_at":{"type":"string","description":"兑换截止时间，RFC3339。省略则从当前时间起 30 天"},"note":{"type":"string","description":"备注，最多 200 字"},"product":{"type":"string","description":"可省略。激活码工具只接受 member_seats，额度卡工具只接受 wallet_credits"}},"required":["member_seats","quantity","duration_days"],"additionalProperties":false}`

func adminToolDefinitions() []map[string]any {
	return []map[string]any{
		{
			"name":         toolActivation,
			"description":  "生成激活码（成员名额兑换码）。仅超级管理员在完成验证器绑定和二次验证后可调用。数量、档位、有效期与管理端创建接口相同。明文码只出现在本次结果里。",
			"inputSchema":  json.RawMessage(codeInputSchema),
			"outputSchema": json.RawMessage(`{"type":"object"}`),
			"annotations":  map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
		},
		{
			"name":         toolQuota,
			"description":  "生成额度卡（钱包额度兑换码）。仅超级管理员在完成验证器绑定和二次验证后可调用。数量、面额、有效期与管理端创建接口相同。明文码只出现在本次结果里。",
			"inputSchema":  json.RawMessage(codeInputSchema),
			"outputSchema": json.RawMessage(`{"type":"object"}`),
			"annotations":  map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
		},
		{
			"name":         toolListCodes,
			"description":  "查询激活码与额度卡列表。结果只有掩码和批次，不含明文码。仅超级管理员在完成二次验证后可调用。",
			"inputSchema":  json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
			"outputSchema": json.RawMessage(`{"type":"object"}`),
			"annotations":  map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
		},
	}
}
