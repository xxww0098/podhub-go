package contract

import (
	"context"
	"time"
)

// DueScan is one reconciler tick. The assembly layer supplies its operation.
type DueScan struct {
	Name    string
	Base    time.Duration
	IdleMax time.Duration
	Batch   int
	Enabled func() bool
	Tick    func(context.Context) (bool, error)
}
