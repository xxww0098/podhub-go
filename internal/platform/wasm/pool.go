package wasm

import "context"

// Slot is one pooled guest. The borrower is the only goroutine that
// touches Guest until it returns the slot.
type Slot struct {
	Guest *Guest
}

// Pool is a fixed set of guest slots. Borrow blocks when every slot is
// out, so a full pool queues the call instead of dropping it.
type Pool struct {
	slots chan *Slot
}

// NewPool returns a pool of n idle slots. n below 1 becomes 1.
func NewPool(n int) *Pool {
	if n < 1 {
		n = 1
	}
	p := &Pool{slots: make(chan *Slot, n)}
	for i := 0; i < n; i++ {
		p.slots <- &Slot{}
	}
	return p
}

// Borrow takes an exclusive slot, waiting until one is returned or ctx ends.
// If cancellation is observed after acquisition, the slot is returned
// before Borrow reports the context error.
func (p *Pool) Borrow(ctx context.Context) (*Slot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case slot := <-p.slots:
		if err := ctx.Err(); err != nil {
			p.Return(slot)
			return nil, err
		}
		return slot, nil
	}
}

// Return puts the slot back. The guest may be nil after a trap.
func (p *Pool) Return(s *Slot) { p.slots <- s }

// Close drops this slot's guest. Other slots are left alone.
func (s *Slot) Close(ctx context.Context) {
	if s == nil || s.Guest == nil {
		return
	}
	_ = s.Guest.Close(ctx)
	s.Guest = nil
}
