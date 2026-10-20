package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCanceledCallPreservesPoolAndGuest(t *testing.T) {
	mod, err := openSized(context.Background(), embedded, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer mod.Close(context.Background())
	cse := firstFreezeCase(t)
	for _, exhausted := range []bool{false, true} {
		name := "available"
		if exhausted {
			name = "exhausted"
		}
		t.Run(name, func(t *testing.T) {
			held, err := mod.pool.Borrow(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			guest := held.Guest
			if !exhausted {
				mod.pool.Return(held)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			completed := make(chan error, 1)
			go func() {
				_, err := mod.Call(ctx, cse.Op, []byte(cse.Schema), []byte(cse.Body))
				completed <- err
			}()
			select {
			case err := <-completed:
				if !errors.Is(err, context.Canceled) {
					t.Errorf("Call error = %v, want context.Canceled", err)
				}
			case <-time.After(time.Second):
				t.Error("canceled Call did not finish while slot was held")
			}
			if exhausted {
				mod.pool.Return(held)
			}
			ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			got, err := mod.Call(ctx, cse.Op, []byte(cse.Schema), []byte(cse.Body))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != cse.Result {
				t.Fatal("result bytes differ after canceled call")
			}
			if held.Guest != guest {
				t.Fatal("canceled call replaced the healthy guest")
			}
		})
	}
}
