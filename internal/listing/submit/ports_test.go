package submit

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/queue/contract"
)

func TestSettlementUsesInstanceQueueAndKeepsLeaseFence(t *testing.T) {
	ctx := context.Background()
	lease := contract.Lease{ID: uuid.New(), Owner: "worker", Epoch: 7}
	called := false
	svc := Service{Queue: Queue{MutateRunning: func(got context.Context, _ *pgxpool.Pool, fence contract.Lease, fn func(context.Context, pgx.Tx) error) (bool, error) {
		if got != ctx || fence != lease {
			t.Fatal("queue port lost the context or lease fence")
		}
		return true, fn(got, nil)
	}}}
	if err := svc.mutateSettlement(ctx, nil, lease, func(context.Context, pgx.Tx) error { called = true; return nil }); err != nil || !called {
		t.Fatalf("injected settlement: called=%v err=%v", called, err)
	}
	backend := errors.New("queue backend")
	for _, tc := range []struct {
		name  string
		queue Queue
	}{
		{name: "missing"},
		{name: "lost lease", queue: Queue{MutateRunning: func(context.Context, *pgxpool.Pool, contract.Lease, func(context.Context, pgx.Tx) error) (bool, error) {
			return false, nil
		}}},
		{name: "backend error", queue: Queue{MutateRunning: func(context.Context, *pgxpool.Pool, contract.Lease, func(context.Context, pgx.Tx) error) (bool, error) {
			return false, backend
		}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			other := Service{Queue: tc.queue}
			err := other.mutateSettlement(ctx, nil, lease, func(context.Context, pgx.Tx) error { t.Fatal("unowned lease must not mutate rows"); return nil })
			if err == nil || (tc.name == "backend error" && !errors.Is(err, backend)) {
				t.Fatalf("settlement must fail closed: %v", err)
			}
		})
	}
}
