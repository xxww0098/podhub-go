package contract

// AdmitError is a store admission outcome. Code is SCREAMING_SNAKE_CASE.
// Field order on the wire is error then code.
type AdmitError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter int
}

func (e *AdmitError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// MissingStore is the invisible-store 404.
func MissingStore() error {
	return &AdmitError{Status: 404, Code: "NOT_FOUND", Message: "Store 不存在"}
}

// InternalAdmit is the fixed 500. It carries no key material.
func InternalAdmit() error {
	return &AdmitError{Status: 500, Code: "INTERNAL", Message: "服务暂不可用"}
}
