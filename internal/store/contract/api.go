package contract

import (
	"errors"
	"net/http"
)

// The Workspace Store wire error codes, from WorkspaceStoreErrorCode. The
// strings are SCREAMING_SNAKE on the wire; changing one changes the contract.
const (
	CodeAuthInvalid         = "AUTH_INVALID"
	CodeAuthRequired        = "AUTH_REQUIRED"
	CodeForbidden           = "FORBIDDEN"
	CodeValidation          = "VALIDATION"
	CodeConflict            = "CONFLICT"
	CodeNotFound            = "NOT_FOUND"
	CodeInternal            = "INTERNAL"
	CodeWritesDisabled      = "WRITES_DISABLED"
	CodeQuotaExhausted      = "QUOTA_EXHAUSTED"
	CodeUpstreamPathRefused = "UPSTREAM_PATH_NOT_ALLOWED"
	CodeUpstreamRateLimited = "UPSTREAM_RATE_LIMITED"
	CodeUpstreamUnreachable = "UPSTREAM_UNREACHABLE"
	CodeCredentialExpired   = "CREDENTIAL_EXPIRED"
	CodeProductSyncCooldown = "PRODUCT_SYNC_COOLDOWN"
	CodeManualTooSoon       = "MANUAL_TOO_SOON"
)

// Messages the Rust handlers write verbatim. The wire carries Chinese copy, so
// these are contract, not presentation.
const (
	MsgInvalidJSON        = "请求格式无效"
	MsgStoreNameEmpty     = "Store 名称不能为空"
	MsgStoreNameLong      = "Store 名称过长"
	MsgClientIDLong       = "Client ID 过长"
	MsgClientIDEmpty      = "Client ID 不能为空"
	MsgAPIKeyLong         = "Api-Key 过长"
	MsgAPIKeyEmpty        = "Api-Key 不能为空"
	MsgStoreUUID          = "Store UUID 无效"
	MsgStoreMissing       = "Store 不存在"
	MsgStoreDeleted       = "Store 已删除"
	MsgWorkspaceMissing   = "Workspace 不存在"
	MsgMemberUnusable     = "工作空间成员当前不可用"
	MsgBadRole            = "工作空间角色无效"
	MsgManagerOnly        = "需要主管权限"
	MsgReassignManager    = "需要主管权限才能改派店铺"
	MsgAssigneeForeign    = "指派对象不是本工作空间成员"
	MsgAssigneeOther      = "不能把店铺指派给其他成员"
	MsgClientIDDuplicate  = "同一 Workspace 内 Client ID 必须唯一"
	MsgRevisionStale      = "Store revision 已过期，请刷新后重试"
	MsgRevisionChanged    = "Store revision 已变化，请刷新后重试"
	MsgStoreUpdatedElse   = "Store 已被其他人更新，请刷新后重试"
	MsgPatchEmpty         = "至少需要修改名称、Client ID、指派人密钥管理、标签或分组"
	MsgGrantOwnerOnly     = "只有工作空间所有者可以允许指派人管理密钥"
	MsgGrantNeedsAssignee = "先指定指派人，再允许其管理密钥"
	MsgNoPatchKeyGrant    = "没有修改该店铺凭据身份的权限"
	MsgNoKeyPermission    = "没有管理该店铺密钥的权限"
	MsgTagMissing         = "标签不存在或已删除"
	MsgGroupMissing       = "分组不存在或已删除"
	MsgGroupNameEmpty     = "分组名称不能为空"
	MsgGroupNameLong      = "分组名过长"
	MsgGroupUUID          = "分组 UUID 无效"
	MsgGroupNotFound      = "分组不存在"
	MsgSameGroupName      = "同名分组已存在"
	MsgSameTagName        = "同名标签已存在"
	MsgTagNameEmpty       = "标签名称不能为空"
	MsgTagNameLong        = "标签名过长"
	MsgTagUUID            = "标签 UUID 无效"
	MsgTagNotFound        = "标签不存在"
	MsgKeyHeldClientID    = "已托管密钥的店铺不能直接改 Client ID，请先清除密钥"
	MsgStoreDisabled      = "Store 已被工作空间停用"
	MsgQuotaExhausted     = "店铺名额已满，无法登记密钥"
	MsgConfirmUpload      = "必须确认上收密钥"
	MsgKeyNotRegistered   = "Store 尚未登记密钥"
	MsgKeyGenStale        = "Store 凭据世代已过期"
	MsgKeyRotateNeedsGen  = "密钥已登记，轮换请带上当前凭据世代"
	MsgKeyExpired         = "Seller 密钥已过期，请在卖家后台重新生成后登记"
	MsgKeyCryptoMissing   = "Seller 密钥托管未配置"
	MsgKeyChangedRetest   = "Store 密钥已更新，请重新测试"
	MsgVerifyStateChanged = "Store 状态或 credential_revision 在写入前已变化"
	MsgVerifyNotSaved     = "凭据验证结果未能保存"
	MsgVerifyExpiredShort = "Seller 密钥已过期，请重新登记"
	MsgTombstoneMissing   = "Store 不存在或未被删除"
	MsgWritesStores       = "店铺名册写入未启用"
	MsgWritesCredential   = "密钥托管写入未启用"
	MsgWritesVerify       = "凭据验证写入未启用"
	MsgWritesTombstone    = "墓碑消费确认写入未启用"
	MsgUnavailable        = "服务暂不可用"
	MsgAccountUnusable    = "账号当前不可用"
	MsgNoOrgPermission    = "账号已无组织权限"
	MsgSessionExpired     = "登录已过期，请重新登录"
	MsgNotLoggedIn        = "未登录"
	MsgWorkspaceless      = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"

	MsgProductLimit        = "limit 必须在 1 到 200 之间"
	MsgProductCursor       = "cursor 无效"
	MsgProductScope        = "cursor 不属于当前范围"
	MsgProductNeedle       = "q 最多 256 字节"
	MsgProductStoreMiss    = "店铺不存在"
	MsgProductMissing      = "商品不存在"
	MsgStatusFilter        = "status 取值无效"
	MsgOfferIDs            = "offerIds 需要 1 到 1000 个非空值"
	MsgOfferIDsLong        = "offerIds 过长"
	MsgSyncDisabled        = "商品镜像同步已停用"
	MsgStoreOff            = "店铺已停用"
	MsgFailureCode         = "failure_code 必须来自允许的非密代码列表"
	MsgVerifiedWithFailure = "verified 结果不能携带 failure_code"
	MsgStoreUnavailable    = "Store 当前不可用于凭据验证"
	MsgCredentialRejected  = "Seller 凭据无法通过校验"
	MsgCredentialGenStale  = "credential_revision 已过期，请重新读取 Store"
	MsgVerifyUnavailable   = "商品核实暂不可用"
	MsgVerifyRateLimited   = "Seller 读取限速中，请稍后重试"
	MsgVerifyThrottled     = "Seller 限流，请稍后重试"
	MsgVerifyGateway       = "Seller 网关暂不可用"
	MsgVerifyUpstream      = "Seller 暂时不可用"
	MsgSyncHold            = "店铺处于熔断或退避中"
	MsgSyncBreaker         = "读取熔断中"
	MsgSyncTooSoon         = "手动更新过于频繁"
	MsgImageUnavailable    = "商品图片暂时无法读取"
)

// APIError is a Workspace Store refusal: the HTTP status, the wire code, and
// the message that becomes the `error` field. It is the Go shape of Rust's
// DomainError<WorkspaceStoreErrorCode, _>.
type APIError struct {
	Status  int
	Code    string
	Message string
	// Retention carries optional refusal details such as the manual-sync
	// unlock moment. Nil means the body is just error+code.
	Extra map[string]any
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// AsAPIError reports the refusal behind err.
func AsAPIError(err error) (*APIError, bool) {
	var api *APIError
	if errors.As(err, &api) {
		return api, true
	}
	return nil, false
}

// Validation is HTTP 400 validation.
func Validation(message string) *APIError {
	return &APIError{Status: http.StatusBadRequest, Code: CodeValidation, Message: message}
}

// Forbidden is HTTP 403 forbidden.
func Forbidden(message string) *APIError {
	return &APIError{Status: http.StatusForbidden, Code: CodeForbidden, Message: message}
}

// NotFound is HTTP 404 not_found.
func NotFound(message string) *APIError {
	return &APIError{Status: http.StatusNotFound, Code: CodeNotFound, Message: message}
}

// Conflict is HTTP 409 conflict.
func Conflict(message string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: CodeConflict, Message: message}
}

// Unauthorized is HTTP 401 auth_invalid.
func Unauthorized(message string) *APIError {
	if message == "" {
		message = MsgNotLoggedIn
	}
	return &APIError{Status: http.StatusUnauthorized, Code: CodeAuthInvalid, Message: message}
}

// Internal is HTTP 500 internal. The public body never carries the cause.
func Internal() *APIError {
	return &APIError{Status: http.StatusInternalServerError, Code: CodeInternal, Message: MsgUnavailable}
}

// WritesDisabled is HTTP 503 writes_disabled with the route's own copy.
func WritesDisabled(message string) *APIError {
	return &APIError{Status: http.StatusServiceUnavailable, Code: CodeWritesDisabled, Message: message}
}

// QuotaExhausted is HTTP 409 quota_exhausted.
func QuotaExhausted() *APIError {
	return &APIError{Status: http.StatusConflict, Code: CodeQuotaExhausted, Message: MsgQuotaExhausted}
}

// CredentialExpired is HTTP 409 credential_expired.
func CredentialExpired(message string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: CodeCredentialExpired, Message: message}
}

// RateLimited is HTTP 429 upstream_rate_limited.
func RateLimited(message string) *APIError {
	return &APIError{Status: http.StatusTooManyRequests, Code: CodeUpstreamRateLimited, Message: message}
}

// Unreachable is HTTP 502 upstream_unreachable.
func Unreachable(message string) *APIError {
	return &APIError{Status: http.StatusBadGateway, Code: CodeUpstreamUnreachable, Message: message}
}

// Cooldown is HTTP 409 product_sync_cooldown.
func Cooldown(message string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: CodeProductSyncCooldown, Message: message}
}

// MsgKeyCrypto is HTTP 503: this deployment holds no Seller KEK, so no key can
// be sealed or opened. It is a configuration answer, not a crypto fault.
func MsgKeyCrypto() *APIError {
	return &APIError{Status: http.StatusServiceUnavailable, Code: CodeInternal, Message: MsgKeyCryptoMissing}
}

// WithExtra attaches refusal details and returns the same error.
func (e *APIError) WithExtra(key string, value any) *APIError {
	if e.Extra == nil {
		e.Extra = map[string]any{}
	}
	e.Extra[key] = value
	return e
}
