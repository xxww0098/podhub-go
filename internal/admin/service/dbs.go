package service

import (
	"context"

	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

const (
	msgDbWrites     = "平台货源写入未启用"
	msgPortalWrites = "厂家门户写入未启用"
)

func (s Service) ListDbs(ctx context.Context, actor contract.Actor) ([]domain.SupplierDb, error) {
	if s.Store == nil {
		return nil, unavailable(nil)
	}
	rows, err := s.Store.ListDbs(ctx, actor)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []domain.SupplierDb{}
	}
	return rows, nil
}

func (s Service) CreateDb(ctx context.Context, actor contract.Actor, body []byte) (domain.SupplierDb, *string, error) {
	in, err := domain.DecodeSupplierDb(body)
	if err != nil {
		return domain.SupplierDb{}, nil, err
	}
	if s.Store == nil {
		return domain.SupplierDb{}, nil, unavailable(nil)
	}
	sourceID, err := domain.MintID("src")
	if err != nil {
		return domain.SupplierDb{}, nil, unavailable(err)
	}
	var props []domain.PropSeed
	if in.Template == "factory" {
		ids := make([]string, 5)
		for i := range ids {
			ids[i], err = domain.MintID("prop")
			if err != nil {
				return domain.SupplierDb{}, nil, unavailable(err)
			}
		}
		props, err = domain.FactoryProps(ids)
		if err != nil {
			return domain.SupplierDb{}, nil, err
		}
	}
	password, err := s.oneTimePassword(in.AccountEmail != nil)
	if err != nil {
		return domain.SupplierDb{}, nil, err
	}
	db, initial, err := s.Store.CreateDb(ctx, actor, in, sourceID, props, s.nowMs(), password)
	return db, initial, fillDisabled(err, msgDbWrites)
}

func (s Service) UpdateDb(ctx context.Context, actor contract.Actor, sourceID string, body []byte) (domain.SupplierDb, *string, error) {
	in, err := domain.DecodeSupplierDb(body)
	if err != nil {
		return domain.SupplierDb{}, nil, err
	}
	in.Template = ""
	if s.Store == nil {
		return domain.SupplierDb{}, nil, unavailable(nil)
	}
	password, err := s.oneTimePassword(in.AccountEmail != nil)
	if err != nil {
		return domain.SupplierDb{}, nil, err
	}
	db, initial, err := s.Store.UpdateDb(ctx, actor, sourceID, in, s.nowMs(), password)
	return db, initial, fillDisabled(err, msgDbWrites)
}

func (s Service) DeleteDb(ctx context.Context, actor contract.Actor, sourceID string) error {
	if s.Store == nil {
		return unavailable(nil)
	}
	return fillDisabled(s.Store.DeleteDb(ctx, actor, sourceID), msgDbWrites)
}

func (s Service) CreateProp(ctx context.Context, actor contract.Actor, sourceID string, body []byte) (domain.Prop, error) {
	in, err := domain.DecodeProp(body)
	if err != nil {
		return domain.Prop{}, err
	}
	if s.Store == nil {
		return domain.Prop{}, unavailable(nil)
	}
	propID, err := domain.MintID("prop")
	if err != nil {
		return domain.Prop{}, unavailable(err)
	}
	prop, err := s.Store.CreateProp(ctx, actor, sourceID, propID, in, s.nowMs())
	return prop, fillDisabled(err, msgDbWrites)
}

func (s Service) UpdateProp(ctx context.Context, actor contract.Actor, sourceID, propID string, body []byte) (domain.Prop, error) {
	in, err := domain.DecodeProp(body)
	if err != nil {
		return domain.Prop{}, err
	}
	if s.Store == nil {
		return domain.Prop{}, unavailable(nil)
	}
	prop, err := s.Store.UpdateProp(ctx, actor, sourceID, propID, in, s.nowMs())
	return prop, fillDisabled(err, msgDbWrites)
}

func (s Service) DeleteProp(ctx context.Context, actor contract.Actor, sourceID, propID string) (int64, error) {
	if s.Store == nil {
		return 0, unavailable(nil)
	}
	n, err := s.Store.DeleteProp(ctx, actor, sourceID, propID)
	return n, fillDisabled(err, msgDbWrites)
}

func (s Service) DeleteRow(ctx context.Context, actor contract.Actor, sourceID, productID string) error {
	if s.Store == nil {
		return unavailable(nil)
	}
	return fillDisabled(s.Store.DeleteRow(ctx, actor, sourceID, productID, s.nowMs()), msgDbWrites)
}

func (s Service) oneTimePassword(need bool) (string, error) {
	if !need {
		return "", nil
	}
	id, err := s.publicID()
	if err != nil {
		return "", unavailable(err)
	}
	return "dzp-" + id, nil
}

func hashPassword(password string) (string, error) {
	raw, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return "", &contract.Fail{Kind: contract.KindValidation, Message: "密码加密失败，请重试"}
	}
	return string(raw), nil
}
