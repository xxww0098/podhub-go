package wasm

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPoolBorrowCanceledWithAvailableSlot(t *testing.T) {
	p := NewPool(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 100; i++ {
		slot, err := p.Borrow(ctx)
		if slot != nil || !errors.Is(err, context.Canceled) {
			t.Fatalf("Borrow = (%v, %v), want (nil, context.Canceled)", slot, err)
		}
	}
	assertPoolSlotAvailable(t, p)
}

func TestPoolBorrowCancellationWhileExhausted(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "cancel"
		if deadline {
			name = "deadline"
		}
		t.Run(name, func(t *testing.T) {
			p := NewPool(1)
			held, err := p.Borrow(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			var ctx context.Context
			var cancel context.CancelFunc
			want := context.Canceled
			if deadline {
				ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
				want = context.DeadlineExceeded
			} else {
				ctx, cancel = context.WithCancel(context.Background())
			}
			defer cancel()
			waiting := &waitingContext{Context: ctx, entered: make(chan struct{})}
			completed := make(chan error, 1)
			go func() {
				slot, err := p.Borrow(waiting)
				if slot != nil {
					p.Return(slot)
				}
				completed <- err
			}()
			if !deadline {
				select {
				case <-waiting.entered:
				case <-time.After(time.Second):
					t.Error("borrower did not enter its wait")
				}
				cancel()
			}
			select {
			case err := <-completed:
				if !errors.Is(err, want) {
					t.Errorf("Borrow error = %v, want %v", err, want)
				}
			case <-time.After(time.Second):
				t.Error("canceled borrower waited for a held slot")
			}
			p.Return(held)
			assertPoolSlotAvailable(t, p)
		})
	}
}

func TestPoolBorrowCancelReturnRaceDoesNotLoseSlot(t *testing.T) {
	p := NewPool(1)
	for i := 0; i < 500; i++ {
		held, err := p.Borrow(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			slot, err := p.Borrow(ctx)
			if err == nil {
				p.Return(slot)
			} else if !errors.Is(err, context.Canceled) {
				t.Errorf("Borrow: %v", err)
			}
		}()
		go cancel()
		p.Return(held)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("borrower did not finish")
		}
		cancel()
		assertPoolSlotAvailable(t, p)
	}
}

func assertPoolSlotAvailable(t *testing.T, p *Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	slot, err := p.Borrow(ctx)
	if err != nil || slot == nil {
		t.Fatalf("slot lost: slot=%v err=%v", slot, err)
	}
	p.Return(slot)
	if len(p.slots) != 1 {
		t.Fatalf("available slots = %d, want 1", len(p.slots))
	}
}

// Done signals that Borrow reached its wait, so cancellation is not merely
// tested before Borrow starts.
type waitingContext struct {
	context.Context
	entered chan struct{}
}

func (c *waitingContext) Done() <-chan struct{} {
	close(c.entered)
	return c.Context.Done()
}

// Cancel on the post-acquisition Err check to cover the slot-return branch
// deterministically rather than relying on the scheduler to win a race.
type cancelOnSecondCheck struct {
	context.Context
	cancel context.CancelFunc
	checks int
}

func (c *cancelOnSecondCheck) Err() error {
	c.checks++
	if c.checks == 2 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestPoolBorrowReturnsSlotWhenCanceledAfterAcquisition(t *testing.T) {
	p := NewPool(1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	slot, err := p.Borrow(&cancelOnSecondCheck{Context: ctx, cancel: cancel})
	if slot != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("Borrow = (%v, %v), want (nil, context.Canceled)", slot, err)
	}
	assertPoolSlotAvailable(t, p)
}
