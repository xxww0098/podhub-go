package contract

import "errors"

// Failure is a platform-catalog response. Code is the screaming wire token.
type Failure struct {
	Status     int
	Message    string
	Code       string
	RetryAfter string
}

func (f *Failure) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// Fail builds a domain failure.
func Fail(status int, code, message string) *Failure {
	return &Failure{Status: status, Code: code, Message: message}
}

// AsFailure unwraps a Failure.
func AsFailure(err error) (*Failure, bool) {
	var f *Failure
	if errors.As(err, &f) {
		return f, true
	}
	return nil, false
}
