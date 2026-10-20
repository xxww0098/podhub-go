package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/xxww0098/podhub-go/internal/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
)

type fakeStore struct {
	calls int
	write bool
}

func (f *fakeStore) Reconcile(context.Context, string, string, int64, domain.Ozon) (json.RawMessage, error) {
	f.calls++
	return json.RawMessage(`{"data":{"injection":{"canReconcile":true}}}`), nil
}

func (f *fakeStore) SafeContinue(context.Context, string, string, string, int64, domain.Ozon) (json.RawMessage, error) {
	f.calls++
	f.write = true
	return json.RawMessage(`{"data":{"injection":{}}}`), nil
}

func TestInjectionSwitchStopsBeforeStore(t *testing.T) {
	store := &fakeStore{}
	admin := Admin{Store: store, InjectWrites: false, OzonWritesDisabled: true}
	_, err := admin.SafeContinue(context.Background(), "store", "preset", "actor", 1)
	fail, ok := err.(*contract.Fail)
	if !ok || fail.Status != 503 || fail.Code != "WRITES_DISABLED" || fail.Message != "物流注入写入未启用" {
		t.Fatalf("%v", err)
	}
	if store.calls != 0 {
		t.Fatal("store opened")
	}
}

func TestReconcileIgnoresBothSwitches(t *testing.T) {
	store := &fakeStore{}
	admin := Admin{Store: store, InjectWrites: false, OzonWritesDisabled: true}
	raw, err := admin.Reconcile(context.Background(), "store", "preset", 1)
	if err != nil || store.calls != 1 || store.write {
		t.Fatalf("%s %v calls=%d", raw, err, store.calls)
	}
}

func TestKillSwitchSentence(t *testing.T) {
	if errWrites.Error() != "OZON_WRITE_KILL_SWITCH 已启用，Ozon 实时写入已停止" {
		t.Fatal(errWrites.Error())
	}
	if (disabledOzon{}).Blocked() == nil {
		t.Fatal("open")
	}
}
