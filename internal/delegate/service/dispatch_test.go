package service

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

type fakePort struct {
	called bool
}

func (f *fakePort) Accept(context.Context, int64, int64, string) (string, error) {
	f.called = true
	return "accepted", nil
}
func (f *fakePort) Reject(context.Context, int64, int64, string, string) (string, error) {
	f.called = true
	return "rejected", nil
}
func (f *fakePort) Ship(context.Context, int64, int64, string, string, string, int64) (string, error) {
	f.called = true
	return "shipped", nil
}
func (f *fakePort) ListDispatches(context.Context, int64, int64) ([]contract.DispatchView, error) {
	f.called = true
	return nil, nil
}

func TestSupplierUserRequiredBeforePort(t *testing.T) {
	f := &fakePort{}
	s := New(f)
	if _, err := s.Accept(context.Background(), 1, 0, "x"); err != contract.ErrForbidden || f.called {
		t.Fatalf("accept %v called %v", err, f.called)
	}
	if _, err := s.Reject(context.Background(), 1, 0, "x", ""); err != contract.ErrForbidden || f.called {
		t.Fatal(err)
	}
	if _, err := s.Ship(context.Background(), 1, 0, "x", "", "", 1); err != contract.ErrForbidden || f.called {
		t.Fatal(err)
	}
}

func TestAcceptDelegatesToPort(t *testing.T) {
	f := &fakePort{}
	got, err := New(f).Accept(context.Background(), 0, 7, "id")
	if err != nil || got != "accepted" || !f.called {
		t.Fatalf("%s %v", got, err)
	}
}

func TestPresignAndProxyStayNotPorted(t *testing.T) {
	s := New(nil)
	if err := s.Presign(context.Background()); err != contract.ErrNotPorted {
		t.Fatal(err)
	}
	if err := s.Proxy(context.Background()); err != contract.ErrNotPorted {
		t.Fatal(err)
	}
}
