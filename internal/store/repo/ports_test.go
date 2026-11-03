package storerepo

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/queue/contract"
)

func TestSyncRequiresQueueBeforeStartingWork(t *testing.T) {
	ctx := context.Background()
	job := contract.Claimed{Payload: []byte(`{"storeId":"11111111-1111-4111-8111-111111111111"}`)}
	if err := RunProductSync(ctx, nil, job, nil, seal.Ring{}, "", nil, Queue{}); err == nil {
		t.Fatal("sync without queue operations must fail before touching the store")
	}
	if n, err := SweepDueProductSync(ctx, nil, 1, true, Queue{}); n != 0 || err != nil {
		t.Fatalf("disabled sync must stay idle: n=%d err=%v", n, err)
	}
}
