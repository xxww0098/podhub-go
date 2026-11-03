package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

// Recover queries an existing provider order. An uncertain create is never
// retried: missing provider references remain visible as entry_confirming.
func (s *PaymentRuntime) Recover(ctx context.Context, org int64, id string) (contract.CheckoutOrder, *domain.Notice, error) {
	o, err := s.Store.Get(ctx, org, id)
	if err != nil || o.Status != "pending" || contract.NoChannel(o.Provider) {
		return o, nil, err
	}
	c, err := s.Configuration(ctx, o.Provider)
	if err != nil {
		return o, nil, err
	}
	if c.Provider == "easypay" {
		// Signing a fresh redirect does not send or duplicate a provider trade.
		e, err := s.Gateway.Create(ctx, c, o)
		if err != nil {
			return o, nil, err
		}
		if err = s.Store.SaveEntry(ctx, org, id, e); err != nil {
			return o, nil, err
		}
		o, err = s.Store.Get(ctx, org, id)
		return o, nil, err
	}
	if o.LaunchState == nil && o.QRCode == nil && o.PayURL == nil {
		out, err := s.Launch(ctx, org, id)
		return out, nil, err
	}
	n, err := s.Gateway.Query(ctx, c, o)
	if err != nil {
		return o, nil, err
	}
	return o, n, nil
}

func (s *PaymentRuntime) Close(ctx context.Context, o contract.CheckoutOrder) error {
	c, err := s.Configuration(ctx, o.Provider)
	if err != nil {
		return err
	}
	if o.ProviderRef == nil && o.LaunchState != nil && o.Provider != "alipay" && o.Provider != "wechat" {
		return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "支付渠道尚未确认订单状态，请先查询支付结果"}
	}
	return s.Gateway.Close(ctx, c, o)
}
