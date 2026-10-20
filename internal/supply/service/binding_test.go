package service

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

type fakePort struct{ called bool }

func (f *fakePort) GetBinding(context.Context, int64, string) (contract.Binding, error) {
	f.called = true
	return contract.Binding{PlatformSKUID: "sku"}, nil
}

func TestGetBindingRequiresOrg(t *testing.T) {
	f := &fakePort{}
	if _, err := New(f).GetBinding(context.Background(), 0, "row"); err != contract.ErrNoTenant || f.called {
		t.Fatal(err)
	}
	got, err := New(f).GetBinding(context.Background(), 4, "row")
	if err != nil || got.PlatformSKUID != "sku" || !f.called {
		t.Fatalf("%+v %v", got, err)
	}
}
