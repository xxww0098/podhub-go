package service

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

type memRepo struct {
	calls int
}

func (m *memRepo) Workbench(context.Context, int64) (domain.Workbench, error) {
	m.calls++
	return domain.Workbench{}, nil
}
func (m *memRepo) Ledger(context.Context, int64) ([]domain.LedgerView, error) {
	m.calls++
	return nil, nil
}
func (m *memRepo) Withdrawals(context.Context, int64) ([]domain.WithdrawalView, error) {
	m.calls++
	return nil, nil
}
func (m *memRepo) Claim(context.Context, contract.Actor, string) (string, error) {
	m.calls++
	return "", nil
}
func (m *memRepo) SavePayout(context.Context, contract.Actor, *string, *string, *string) (domain.Payout, bool, error) {
	m.calls++
	return domain.Payout{}, false, nil
}
func (m *memRepo) Transfer(context.Context, contract.Actor, string, int64) (domain.Transfer, error) {
	m.calls++
	return domain.Transfer{}, nil
}
func (m *memRepo) RequestWithdrawal(context.Context, contract.Actor, int64) (domain.WithdrawalView, error) {
	m.calls++
	return domain.WithdrawalView{}, nil
}

func TestLoggedOutDoesNotTouchTheStore(t *testing.T) {
	repo := &memRepo{}
	svc := New(repo)
	ctx := context.Background()
	actor := contract.Actor{}
	if _, err := svc.Workbench(ctx, actor); failureKind(err) != contract.KindUnauth {
		t.Fatal(err)
	}
	if _, err := svc.Ledger(ctx, actor); failureKind(err) != contract.KindUnauth {
		t.Fatal(err)
	}
	if _, err := svc.Claim(ctx, actor, "ABCD"); failureKind(err) != contract.KindUnauth {
		t.Fatal(err)
	}
	if _, _, err := svc.SavePayout(ctx, actor, nil, nil, nil); failureKind(err) != contract.KindUnauth {
		t.Fatal(err)
	}
	if _, err := svc.Transfer(ctx, actor, "op", 1); failureKind(err) != contract.KindUnauth {
		t.Fatal(err)
	}
	if _, err := svc.RequestWithdrawal(ctx, actor, 1); failureKind(err) != contract.KindUnauth {
		t.Fatal(err)
	}
	if repo.calls != 0 {
		t.Fatal(repo.calls)
	}
}

func TestOrgZeroStillReads(t *testing.T) {
	repo := &memRepo{}
	if _, err := New(repo).Workbench(context.Background(), contract.Actor{UserID: 7}); err != nil {
		t.Fatal(err)
	}
	if repo.calls != 1 {
		t.Fatal(repo.calls)
	}
}

func failureKind(err error) string {
	f, ok := err.(*contract.Failure)
	if !ok {
		return ""
	}
	return f.Kind
}
