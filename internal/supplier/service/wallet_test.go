package service

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

type fakePort struct{ called bool }

func (f *fakePort) ListWallets(context.Context, int64, int64) ([]contract.Wallet, error) {
	f.called = true
	return []contract.Wallet{{SourceID: "s", BalanceMicrofen: 1}}, nil
}
func (f *fakePort) ListWithdrawals(context.Context, int64, int64) ([]contract.WithdrawalRow, error) {
	return nil, nil
}

func TestRequestWithdrawalDoesNotPersist(t *testing.T) {
	f := &fakePort{}
	s := New(f)
	if err := s.RequestWithdrawal(context.Background(), 0, "alipay", false); err != contract.ErrInvalid || f.called {
		t.Fatalf("invalid %v", err)
	}
	if err := s.RequestWithdrawal(context.Background(), 10, "alipay", false); err != contract.ErrUnproven || f.called {
		t.Fatalf("unproven %v called %v", err, f.called)
	}
}

func TestDownloadStaysNotPorted(t *testing.T) {
	if err := New(nil).Download(context.Background()); err != contract.ErrNotPorted {
		t.Fatal(err)
	}
}
