package contract

import "errors"

// Failure is a supplier response the handler prints as JSON.
// Code is already the wire token (snake_case on the portal, screaming on supplier-dbs).
type Failure struct {
	Status     int
	Message    string
	Code       string
	RetryAfter string
	Missing    []string
}

func (f *Failure) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// Fail builds a domain failure. Status is chosen by the HTTP layer when it is 0.
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
