package contract

// APIError is the admin wire failure. Field names match contract.APIError.
type APIError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter string
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Fail builds an API error. Message is the JSON error field.
func Fail(status int, code, message string) *APIError {
	return &APIError{Status: status, Code: code, Message: message}
}

// NotPorted is the envelope for a branch this port does not invent.
func NotPorted() *APIError { return Fail(501, "not_ported", "not_ported") }
