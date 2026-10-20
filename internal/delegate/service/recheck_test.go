package service

import (
	"context"
	"testing"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

func TestFinalizeRecheckSession(t *testing.T) {
	actor := Actor{UserID: 4, OrgID: 7}
	same := WithSessionRecheck(context.Background(), func() (int64, int64, error) { return 4, 7, nil })
	if err := recheckSession(same, actor); err != nil {
		t.Fatal(err)
	}
	changed := WithSessionRecheck(context.Background(), func() (int64, int64, error) { return 9, 7, nil })
	err := recheckSession(changed, actor)
	if err == nil || err.Error() != "上传期间登录或工作空间已变化" {
		t.Fatal(err)
	}
	var api *contract.APIError
	if !asFault(err, &api) || api.Status != 403 || api.Code != "forbidden" {
		t.Fatalf("%v", err)
	}
	if err := recheckSession(context.Background(), actor); err != nil {
		t.Fatal(err)
	}
}

func asFault(err error, api **contract.APIError) bool {
	value, ok := err.(*contract.APIError)
	if ok {
		*api = value
	}
	return ok
}

func TestFinalizeRewritesStorageConflict(t *testing.T) {
	s := Seller{
		DB: gateDB{},
		Edge: Edge{
			Storage: func(context.Context) (string, int64, error) { return "", 1, nil },
			Confirm: func(context.Context, string, int64, int64, string) (Confirmed, error) {
				return Confirmed{}, contract.Conflict("上传对象校验不一致，请勿覆盖该对象")
			},
		},
	}
	_, err := s.Finalize(context.Background(), Actor{UserID: 1, OrgID: 2, CanManage: true},
		"11111111-1111-4111-8111-111111111111", "ticket", "a.png", 0)
	var api *contract.APIError
	if !asFault(err, &api) || api.Status != 422 || api.Code != "validation" || api.Message != "文件内容与上传授权不符，请勿覆盖该对象" {
		t.Fatalf("%v", err)
	}
}

type gateDB struct{}

func (gateDB) ListSources(context.Context, int64) ([]contract.Source, error) { return nil, nil }
func (gateDB) StoreGate(context.Context, int64, int64, bool, string) (string, error) {
	return "", nil
}
func (gateDB) VisibleStoreUUIDs(context.Context, int64, int64, bool) ([]string, error) {
	return nil, nil
}
func (gateDB) AdmitStore(context.Context, int64, int64, bool, string, int64) (contract.SealedCredential, error) {
	return contract.SealedCredential{}, nil
}
func (gateDB) ListBindings(context.Context, int64, string) ([]contract.Binding, error) {
	return nil, nil
}
func (gateDB) BindingStore(context.Context, int64, int64, bool, string) (string, string, error) {
	return "11111111-1111-4111-8111-111111111111", "b", nil
}
func (gateDB) CreateBinding(context.Context, int64, int64, string, string, string, string, bool, int64) (contract.Binding, error) {
	return contract.Binding{}, nil
}
func (gateDB) PatchBinding(context.Context, int64, int64, bool, string, int64, *string, *string, *bool, bool, int64) (contract.Binding, error) {
	return contract.Binding{}, nil
}
func (gateDB) DeleteBinding(context.Context, int64, int64, bool, string, int64) error { return nil }
func (gateDB) CommitAsset(context.Context, int64, int64, bool, contract.AssetIdentity, bool, int64, func() error, func() error) (contract.Asset, error) {
	return contract.Asset{}, nil
}
func (gateDB) DeleteAsset(context.Context, int64, int64, bool, string, bool, int64) (contract.DeletedAsset, error) {
	return contract.DeletedAsset{}, nil
}
func (gateDB) ListOrders(context.Context, int64, contract.OrderQuery) ([]contract.Order, bool, string, error) {
	return nil, false, "", nil
}
func (gateDB) GetOrder(context.Context, int64, int64, bool, string) (contract.Order, error) {
	return contract.Order{}, nil
}
func (gateDB) CreateOrder(context.Context, int64, contract.CreateInput) (contract.Order, error) {
	return contract.Order{}, nil
}
func (gateDB) CancelOrder(context.Context, int64, int64, bool, string, int64) (contract.Order, error) {
	return contract.Order{}, nil
}
func (gateDB) CloseOrder(context.Context, int64, int64, bool, string, int64) (contract.Order, error) {
	return contract.Order{}, nil
}
func (gateDB) NudgeOrder(context.Context, int64, int64, bool, string, int64) (contract.Order, error) {
	return contract.Order{}, nil
}
func (gateDB) LoadMerge(context.Context, int64, string) (contract.MergeSnapshot, error) {
	return contract.MergeSnapshot{}, nil
}
func (gateDB) PostingStates(context.Context, int64, string, []string) ([]contract.PostingHit, error) {
	return nil, nil
}
