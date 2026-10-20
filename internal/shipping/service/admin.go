package service

import (
	"context"
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
)

// Admin runs reconcile and safe-continue.
// InjectWrites is the parsed injection switch. OzonWritesDisabled is the kill switch.
// Neither bool is read from the environment here.
type Admin struct {
	Store              domain.Store
	Ozon               domain.Ozon
	InjectWrites       bool
	OzonWritesDisabled bool
	Now                func() int64
}

// Reconcile lists warehouses. It does not look at either switch.
func (a Admin) Reconcile(ctx context.Context, storeUUID, presetID string, now int64) (json.RawMessage, error) {
	if a.Now != nil {
		now = a.Now()
	}
	if a.Store == nil {
		return nil, contract.Internal("")
	}
	return a.Store.Reconcile(ctx, storeUUID, presetID, now, a.ozon(false))
}

// SafeContinue refuses when injection writes are off, before any dial and
// before the store is opened. The kill switch is applied to the write port
// so the store can refuse after the row and the credential, before claim.
func (a Admin) SafeContinue(ctx context.Context, storeUUID, presetID, actor string, now int64) (json.RawMessage, error) {
	if !a.InjectWrites {
		return nil, contract.WritesDisabled("")
	}
	if a.Now != nil {
		now = a.Now()
	}
	if a.Store == nil {
		return nil, contract.Internal("")
	}
	return a.Store.SafeContinue(ctx, storeUUID, presetID, actor, now, a.ozon(true))
}

func (a Admin) ozon(write bool) domain.Ozon {
	if write && a.OzonWritesDisabled {
		return disabledOzon{inner: a.Ozon}
	}
	return a.Ozon
}

type disabledOzon struct{ inner domain.Ozon }

func (d disabledOzon) Blocked() error { return errWrites }

func (d disabledOzon) Post(ctx context.Context, path string, body []byte, write bool, clientID, apiKey string) (int, []byte, error) {
	if write {
		return 0, nil, errWrites
	}
	if d.inner == nil {
		return 0, nil, contract.Gateway("物流注入暂时无法联系店铺")
	}
	return d.inner.Post(ctx, path, body, false, clientID, apiKey)
}

// errWrites is the kill switch seen by the write path.
var errWrites = writesError{}

type writesError struct{}

func (writesError) Error() string {
	return "OZON_WRITE_KILL_SWITCH 已启用，Ozon 实时写入已停止"
}
