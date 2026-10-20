package domain

import (
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
)

func open() Gate {
	return Gate{RuntimeLive: true, EpochMatch: true, GrantLive: true, SameRuntime: true}
}

func TestCommandEdges(t *testing.T) {
	hold := open()
	expired := hold
	expired.LeaseExpired = true
	cases := []struct {
		status, edge string
		gate         Gate
		next         string
		err          error
	}{
		{StatusQueued, EdgeClaim, hold, StatusClaimed, nil},
		{StatusClaimed, EdgeClaim, expired, StatusClaimed, nil},
		{StatusClaimed, EdgeClaim, hold, "", contract.ErrNotApplied},
		{StatusCompleted, EdgeClaim, expired, "", contract.ErrNotApplied},
		{StatusFailed, EdgeClaim, expired, "", contract.ErrNotApplied},
		{StatusCanceled, EdgeClaim, expired, "", contract.ErrNotApplied},
		{StatusQueued, EdgeClaim, Gate{RuntimeLive: true}, "", contract.ErrNotApplied},
		{StatusQueued, EdgeClaim, Gate{GrantLive: true}, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeRenew, hold, StatusClaimed, nil},
		{StatusClaimed, EdgeRenew, expired, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeRenew, Gate{RuntimeLive: true, EpochMatch: true, SameRuntime: true}, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeRenew, Gate{RuntimeLive: true, GrantLive: true, SameRuntime: true}, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeRenew, Gate{RuntimeLive: true, EpochMatch: true, GrantLive: true}, "", contract.ErrNotApplied},
		{StatusQueued, EdgeRenew, hold, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeProgress, hold, StatusClaimed, nil},
		{StatusClaimed, EdgeProgress, Gate{RuntimeLive: true, EpochMatch: true, SameRuntime: true}, StatusClaimed, nil},
		{StatusClaimed, EdgeProgress, expired, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeProgress, Gate{RuntimeLive: true, GrantLive: true, EpochMatch: true}, "", contract.ErrNotApplied},
		{StatusCompleted, EdgeProgress, hold, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeSettleCompleted, hold, StatusCompleted, nil},
		{StatusClaimed, EdgeSettleCompleted, Gate{RuntimeLive: true, EpochMatch: true, SameRuntime: true}, StatusCompleted, nil},
		{StatusClaimed, EdgeSettleFailed, hold, StatusFailed, nil},
		{StatusClaimed, EdgeSettleCanceled, hold, StatusCanceled, nil},
		{StatusClaimed, EdgeSettleCompleted, expired, "", contract.ErrNotApplied},
		{StatusQueued, EdgeSettleCompleted, hold, "", contract.ErrNotApplied},
		{StatusClaimed, EdgeRelease, hold, StatusQueued, nil},
		{StatusClaimed, EdgeRelease, Gate{RuntimeLive: true}, "", contract.ErrNotApplied},
		{StatusQueued, EdgeRelease, hold, "", contract.ErrNotApplied},
		{StatusCompleted, EdgeRelease, hold, "", contract.ErrNotApplied},
		{"running", EdgeClaim, hold, "", contract.ErrIllegalStatus},
		{StatusQueued, "leap", hold, "", contract.ErrIllegalEdge},
		{StatusQueued, "", hold, "", contract.ErrIllegalEdge},
		{"", EdgeClaim, hold, "", contract.ErrIllegalStatus},
	}
	for _, tc := range cases {
		next, err := Apply(tc.status, tc.edge, tc.gate)
		if next != tc.next || !errors.Is(err, tc.err) {
			t.Fatalf("%s %s -> %q %v, want %q %v", tc.status, tc.edge, next, err, tc.next, tc.err)
		}
	}
}

func TestRenewControl(t *testing.T) {
	hold := open()
	if RenewControl(StatusClaimed, hold) != ControlContinue {
		t.Fatal("continue")
	}
	hold.CancelRequested = true
	if RenewControl(StatusClaimed, hold) != ControlCancel {
		t.Fatal("cancel")
	}
	if RenewControl(StatusClaimed, Gate{}) != ControlLost {
		t.Fatal("lost")
	}
}

func TestCommandVocabulary(t *testing.T) {
	if len(Edges()) != 7 {
		t.Fatal(len(Edges()))
	}
	for _, status := range Statuses() {
		if got, ok := ParseStatus(status); !ok || got != status {
			t.Fatal(status)
		}
	}
	for _, action := range []string{ActionAssetsImport, ActionListingPrepare, "submit"} {
		_, ok := ParseAction(action)
		if ok != (action != "submit") {
			t.Fatal(action)
		}
	}
	if ClaimLeaseSeconds != 90 || RuntimeStaleMillis != 45000 || ClaimLimitDefault != 4 || ClaimLimitMax != 8 {
		t.Fatal("lease constants")
	}
}

func TestRuntimeLiveBoundary(t *testing.T) {
	const now int64 = 1_000_000
	if !RuntimeLive(now, now-RuntimeStaleMillis) || RuntimeLive(now, now-RuntimeStaleMillis-1) {
		t.Fatal("45s boundary")
	}
}
