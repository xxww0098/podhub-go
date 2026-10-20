package queue

import (
	"github.com/xxww0098/podhub-go/internal/queue/contract"
	"github.com/xxww0098/podhub-go/internal/queue/domain"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"math"
	"testing"
	"time"
)

func TestBackoffMatchesIndependentVectors(t *testing.T) {
	if domain.JitterSeed("job-a", 1, 1) != 10901668784123036940 {
		t.Fatalf("jitter seed job-a = %d", domain.JitterSeed("job-a", 1, 1))
	}
	if domain.JitterSeed("job-b", 1, 1) == domain.JitterSeed("job-a", 1, 1) {
		t.Fatal("job id must change the seed")
	}
	if domain.JitterSeed("job-a", 2, 1) == domain.JitterSeed("job-a", 1, 1) || domain.JitterSeed("job-a", 1, 2) == domain.JitterSeed("job-a", 1, 1) {
		t.Fatal("epoch and attempt must change the seed")
	}
	vectors := []struct {
		kind    string
		attempt int32
		reason  domain.RequeueReason
		hint    time.Duration
		seed    uint64
		wantMs  int64
	}{
		{"listing.submit", 1, domain.ReasonRateLimited, 5 * time.Second, 0, 5884},
		{"listing.submit", 1, domain.ReasonRateLimited, 0, 0, 1082},
		{"listing.submit", 7, domain.ReasonStoreBusy, 750 * time.Millisecond, 0, 2100},
		{"media.thumb", 3, domain.ReasonSafeToRetry, 0, 0, 23262},
		{"listing.submit", 1, domain.ReasonRateLimited, 5 * time.Second, 1, 7405},
		{"listing.submit", 1, domain.ReasonRateLimited, 0, 1, 1281},
		{"listing.submit", 7, domain.ReasonStoreBusy, 750 * time.Millisecond, 1, 2240},
		{"media.thumb", 3, domain.ReasonSafeToRetry, 0, 1, 26004},
		{"listing.submit", 1, domain.ReasonRateLimited, 5 * time.Second, 7, 5464},
		{"listing.submit", 1, domain.ReasonRateLimited, 0, 7, 1279},
		{"listing.submit", 7, domain.ReasonStoreBusy, 750 * time.Millisecond, 7, 2310},
		{"media.thumb", 3, domain.ReasonSafeToRetry, 0, 7, 20888},
		{"listing.submit", 1, domain.ReasonRateLimited, 5 * time.Second, 42, 5816},
		{"listing.submit", 1, domain.ReasonRateLimited, 0, 42, 1073},
		{"listing.submit", 7, domain.ReasonStoreBusy, 750 * time.Millisecond, 42, 2152},
		{"media.thumb", 3, domain.ReasonSafeToRetry, 0, 42, 27124},
		{"media.thumb", 1, domain.ReasonStoreBusy, 4000 * time.Second, 7, 4_000_000},
		{"listing.submit", 9, domain.ReasonRateLimited, 4000 * time.Second, 42, 4_007_533},
	}
	for _, tc := range vectors {
		got := domain.RequeueDelay(tc.kind, tc.attempt, tc.reason, tc.hint, tc.seed)
		if got.Milliseconds() != tc.wantMs {
			t.Fatalf("%s attempt %d %s seed %d: got %d ms, want %d", tc.kind, tc.attempt, tc.reason, tc.seed, got.Milliseconds(), tc.wantMs)
		}
	}
}

func TestHugeRetryAfterDoesNotPanic(t *testing.T) {
	got := domain.RequeueDelay("listing.submit", 1, domain.ReasonRateLimited, time.Duration(math.MaxInt64), 7)
	if got != time.Duration(math.MaxInt64) {
		t.Fatalf("got %s", got)
	}
}

func TestRequeueWithdrawsNonFaultAttempts(t *testing.T) {
	got := domain.Requeue(3, 8, domain.ReasonStoreBusy)
	if got.State != "retry_wait" || got.Attempt != 2 || got.ErrorCode != "store_busy" {
		t.Fatalf("%+v", got)
	}
	fault := domain.Requeue(8, 8, domain.ReasonSafeToRetry)
	if fault.State != "failed" || fault.Attempt != 8 {
		t.Fatalf("%+v", fault)
	}
	early := domain.Requeue(1, 8, domain.ReasonSafeToRetry)
	if early.State != "retry_wait" || early.Attempt != 1 {
		t.Fatalf("%+v", early)
	}
}

func TestLeaseOutcomesByKind(t *testing.T) {
	cases := []struct {
		in   domain.LeaseInput
		want domain.LeaseResult
	}{
		{domain.LeaseInput{Kind: "listing.submit", Executor: "cloud", Attempt: 1, MaxAttempts: 8, LastError: "old"},
			domain.LeaseResult{State: "failed", LastError: "old", ClearLease: true}},
		{domain.LeaseInput{Kind: "listing.submit", Executor: "cloud", Attempt: 8, MaxAttempts: 8, LastError: "old"},
			domain.LeaseResult{State: "failed", LastError: "max_attempts_exhausted", ClearLease: true}},
		{domain.LeaseInput{Kind: "listing.submit.batch", Intents: 2, Executor: "cloud", Attempt: 1, MaxAttempts: 8},
			domain.LeaseResult{State: "failed", ClearLease: true}},
		{domain.LeaseInput{Kind: "listing.submit.batch", Intents: 0, Executor: "cloud", Attempt: 1, MaxAttempts: 8, LastError: "keep"},
			domain.LeaseResult{State: "retry_wait", LastError: "keep", ClearLease: true}},
		{domain.LeaseInput{Kind: "ai.recognize", Executor: "browser", Attempt: 8, MaxAttempts: 8, LastError: "old"},
			domain.LeaseResult{State: "uncertain", LastError: "attempt_uncertain", ClearLease: false}},
		{domain.LeaseInput{Kind: "store.product_sync", Executor: "cloud", Attempt: 8, MaxAttempts: 8},
			domain.LeaseResult{State: "failed", LastError: "max_attempts_exhausted", ClearLease: true}},
		{domain.LeaseInput{Kind: "store.product_sync", Executor: "browser", Attempt: 8, MaxAttempts: 8, LastError: "keep"},
			domain.LeaseResult{State: "retry_wait", LastError: "keep", ClearLease: true}},
		{domain.LeaseInput{Kind: "listing.reconcile", Executor: "cloud", Attempt: 1, MaxAttempts: 8, LastError: "keep"},
			domain.LeaseResult{State: "retry_wait", LastError: "keep", ClearLease: true}},
	}
	for _, tc := range cases {
		if got := domain.ReclaimExpired(tc.in); got != tc.want {
			t.Fatalf("%s: got %+v want %+v", tc.in.Kind, got, tc.want)
		}
	}
	render := domain.ReclaimExpired(domain.LeaseInput{Kind: "media.render", Attempt: 1, MaxAttempts: 8})
	if !render.Untouched || render.State != "running" {
		t.Fatalf("sweeper must leave media.render running, got %+v", render)
	}
	// The CASE would say uncertain; the sweeper returns first.
	if got := domain.LeaseCase(domain.LeaseInput{Kind: "media.render"}); got.State != "uncertain" || got.ClearLease {
		t.Fatalf("CASE %+v", got)
	}
}

func TestRiverStateIsNotRenamed(t *testing.T) {
	for _, state := range []string{"available", "retryable", "scheduled", "completed", "discarded", "running", "cancelled", "pending"} {
		if _, ok := domain.BusinessStateFromRiver(state); ok {
			t.Fatalf("refusing to rename river state %s", state)
		}
	}
}

func TestDeclarationOrderIsNotVersionOrder(t *testing.T) {
	steps := domain.InvertedTail()
	if steps[0].Version <= steps[1].Version {
		t.Fatal("step 280's stamp must be greater than step 281's")
	}
	if steps[0].Version != steps[2].Version {
		t.Fatal("steps 280 and 282 share a stamp")
	}
	for i, step := range steps {
		if step.GooseVersion != step.Order || step.GooseVersion != 280+i {
			t.Fatalf("goose version must be the declaration index, got %+v", step)
		}
	}
}

func TestLaneCostAndClaimCaps(t *testing.T) {
	if contract.CostUnits("ai.recognize") != 8 || contract.CostUnits("media.upload") != 2 || contract.CostUnits("listing.submit") != 4 || contract.CostUnits("other") != 1 {
		t.Fatal("cost units drifted")
	}
	if !domain.LaneAdmits(248, "ai.recognize") || domain.LaneAdmits(249, "ai.recognize") {
		t.Fatal("8 units fit at 248 and not at 249")
	}
	if domain.ClaimMaxPerUser != 2 || domain.ClaimHeadLimit != 128 || domain.DefaultLeaseSeconds != 30 {
		t.Fatal("claim caps drifted")
	}
	if got := domain.LockOrder(); len(got) != 2 || got[0] != "account_queue_head" || got[1] != "execution_quota" {
		t.Fatalf("lock order %v", got)
	}
}

func TestWorkRequeueKeepsTheAttempt(t *testing.T) {
	if got := domain.WorkRequeue(domain.ErrLockBusy); got != domain.ReasonLockBusy || !got.WithdrawAttempt() {
		t.Fatalf("lock %s", got)
	}
	if got := domain.WorkRequeue(domain.ErrReceiptHeld); got != domain.ReasonStoreBusy || !got.WithdrawAttempt() {
		t.Fatalf("receipt %s", got)
	}
	if got := domain.WorkRequeue(domain.ErrOrgCap); got != domain.ReasonStoreBusy || !got.WithdrawAttempt() {
		t.Fatalf("cap %s", got)
	}
	if got := domain.WorkRequeue(queuerepo.ErrTerminal); got != domain.ReasonSafeToRetry || got.WithdrawAttempt() {
		t.Fatalf("other %s", got)
	}
	locked := domain.Requeue(3, 8, domain.WorkRequeue(domain.ErrLockBusy))
	if locked.State != "retry_wait" || locked.Attempt != 2 {
		t.Fatalf("lock requeue %+v", locked)
	}
}
