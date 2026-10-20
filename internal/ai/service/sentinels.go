package service

// Invalid is the shape refusal relay.go returns. The sentinel stays
// unexported in this package; the value is the same pointer.
func Invalid() error { return errInvalid }
