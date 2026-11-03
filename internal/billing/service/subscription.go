package service

import (
	"time"
)

// PaymentWindow is how long an unpaid order blocks a new one. The HTTP layer
// shows the deadline; the repo sets the same value on the row.
const PaymentWindow = 15 * time.Minute
