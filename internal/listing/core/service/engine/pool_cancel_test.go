package engine

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCanceledCallPreservesPool(t *testing.T) {
	eng, err := openSized(context.Background(), embeddedTagsWASM, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer eng.Close(context.Background())
	held, err := eng.pool.Borrow(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	completed := make(chan error, 1)
	go func() {
		_, err := eng.Call(ctx, "partition", "", "", "", []string{"#rose"}, nil)
		completed <- err
	}()
	select {
	case err := <-completed:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("Call error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Error("canceled Call waited for held slot")
	}
	eng.pool.Return(held)
	if _, err := eng.Call(ctx, "partition", "", "", "", nil, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("Call with available slot error = %v, want context.Canceled", err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := eng.Call(ctx, "partition", "", "", "", []string{"#rose"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Kept) != 1 || got.Kept[0] != "#rose" || len(got.Rejected) != 0 {
		t.Fatalf("unexpected outcome after cancellation: %+v", got)
	}
}
