package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/queue/domain"
)

func TestFinishClaimedMissingWorkDoesNotSettleOrConsumeAttempt(t *testing.T) {
	job := Claimed{ID: uuid.New(), Kind: "listing.submit", Owner: "worker", Epoch: 7, Attempt: 1, MaxAttempts: 1}
	for _, tc := range []struct {
		name      string
		handler   bool
		err       error
		cancelled bool
		want      RequeueReason
	}{
		{name: "missing", want: ReasonAdmissionUnavailable},
		{name: "unavailable", handler: true, err: fmt.Errorf("handler: %w", ErrWorkNotPorted), want: ReasonAdmissionUnavailable},
		{name: "failed", handler: true, err: errors.New("failed"), want: ReasonSafeToRetry},
		{name: "receipt held", handler: true, err: domain.ErrReceiptHeld, want: domain.ReasonStoreBusy},
		{name: "settled by handler", handler: true},
		{name: "cancelled", handler: true, err: context.Canceled, cancelled: true},
		{name: "missing and cancelled", cancelled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancelled {
				cancel()
			}
			calls, requeues := 0, 0
			repo := Repository{}
			repo.RequeueJob = func(got context.Context, _ *pgxpool.Pool, lease Lease, reason RequeueReason, retryAfter time.Duration) (bool, error) {
				requeues++
				if got != ctx || lease != job.Lease() || reason != tc.want || retryAfter != 0 {
					t.Fatalf("requeue: lease=%+v reason=%s retry=%s", lease, reason, retryAfter)
				}
				if reason == ReasonAdmissionUnavailable {
					result := domain.Requeue(job.Attempt, job.MaxAttempts, reason)
					if result.State != "retry_wait" || result.Attempt != 0 {
						t.Fatalf("missing handler consumed the last attempt: %+v", result)
					}
				}
				return true, nil
			}
			opts := Options{Repo: repo}
			if tc.handler {
				opts.Work = func(got context.Context, _ *pgxpool.Pool, claimed Claimed) error {
					calls++
					if got != ctx || claimed.ID != job.ID || claimed.Epoch != job.Epoch {
						t.Fatal("handler lost the claimed job or cancellation context")
					}
					return tc.err
				}
			}
			finishClaimed(ctx, nil, opts, job)
			if (calls == 1) != tc.handler || (requeues == 1) != (tc.want != "") {
				t.Fatalf("handler calls=%d requeues=%d", calls, requeues)
			}
		})
	}
}

func TestRunRejectsIncompleteRepositoryBeforeClaiming(t *testing.T) {
	for _, missing := range []string{"claim", "owner", "sweep", "running", "requeue"} {
		t.Run(missing, func(t *testing.T) {
			repo := Repository{
				Claim: func(context.Context, *pgxpool.Pool, string, string, int) ([]Claimed, error) {
					t.Fatal("must not claim with missing dependencies")
					return nil, nil
				},
				FormatOwner:        func(string, string) string { t.Fatal("must validate before generating an owner"); return "" },
				ReclaimExpiredRows: func(context.Context, *pgxpool.Pool, string) (int, error) { return 0, nil },
				RunningOwned:       func(context.Context, *pgxpool.Pool, string, []string) (int, error) { return 0, nil },
				RequeueJob: func(context.Context, *pgxpool.Pool, Lease, RequeueReason, time.Duration) (bool, error) {
					return true, nil
				},
			}
			switch missing {
			case "claim":
				repo.Claim = nil
			case "owner":
				repo.FormatOwner = nil
			case "sweep":
				repo.ReclaimExpiredRows = nil
			case "running":
				repo.RunningOwned = nil
			case "requeue":
				repo.RequeueJob = nil
			}
			if err := Run(context.Background(), nil, Options{Repo: repo}); err == nil {
				t.Fatal("missing queue dependency was accepted")
			}
		})
	}
}
