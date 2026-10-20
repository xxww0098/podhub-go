// Package contract is the shipping-injection admin boundary.
package contract

// Fail is one admin HTTP outcome. Field order is error then code.
// ShippingInjectErrorCode is SCREAMING_SNAKE_CASE.
type Fail struct {
	Status     int
	Code       string
	Message    string
	RetryAfter int
}

func (f *Fail) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

func Validation(message string) *Fail {
	return &Fail{Status: 400, Code: "VALIDATION", Message: message}
}

func NotFound(message string) *Fail {
	return &Fail{Status: 404, Code: "NOT_FOUND", Message: message}
}

func Conflict(message string) *Fail {
	return &Fail{Status: 409, Code: "CONFLICT", Message: message}
}

// WritesDisabled is the injection switch or the kill switch. The message is
// the short sentence when the injection switch is off, and the long sentence
// when the kill switch stops a write.
func WritesDisabled(message string) *Fail {
	if message == "" {
		message = "物流注入写入未启用"
	}
	return &Fail{Status: 503, Code: "WRITES_DISABLED", Message: message}
}

func Internal(message string) *Fail {
	if message == "" {
		message = "服务暂不可用"
	}
	return &Fail{Status: 500, Code: "INTERNAL", Message: message}
}

// Gateway is an egress failure. The code stays INTERNAL.
func Gateway(message string) *Fail {
	if message == "" {
		message = "物流注入暂时无法联系店铺"
	}
	return &Fail{Status: 502, Code: "INTERNAL", Message: message}
}

func Locked() *Fail {
	return &Fail{Status: 503, Code: "INTERNAL", Message: "资源正在更新，请稍后重试", RetryAfter: 1}
}

func MediaGone() *Fail {
	return &Fail{Status: 409, Code: "INTERNAL", Message: "媒体对象已进入回收，请重新上传"}
}
