package jobs

import (
	"context"
	"testing"
)

func TestPostingSyncTickIsIdempotentNoop(t *testing.T) {
	if KindPostingSync != "delegate.posting_sync" {
		t.Fatal(KindPostingSync)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 3; i++ {
		worked, err := PostingSyncTick(ctx)
		if worked || err != nil {
			t.Fatalf("tick %d worked %v err %v", i, worked, err)
		}
	}
}
