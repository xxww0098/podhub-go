package service

import (
	"context"
	"strings"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
)

var ErrPaymentClosed = contract.ErrPaymentClosed

type PaymentRuntime struct {
	Store   PaymentStore
	Load    contract.PaymentConfigurations
	Gateway PaymentGateway
}

func (s *PaymentRuntime) Configuration(ctx context.Context, provider string) (contract.PaymentConfiguration, error) {
	switch provider {
	case "alipay", "wechat", "stripe", "airwallex", "easypay", "easypay_alipay", "easypay_wechat":
	default:
		return contract.PaymentConfiguration{}, ErrPaymentClosed
	}
	if s == nil || s.Load == nil || s.Gateway == nil {
		return contract.PaymentConfiguration{}, ErrPaymentClosed
	}
	base := provider
	if strings.HasPrefix(provider, "easypay_") {
		base = "easypay"
	}
	configs, err := s.Load(ctx)
	if err != nil {
		return contract.PaymentConfiguration{}, ErrPaymentClosed
	}
	for _, c := range configs {
		if c.Provider == base && c.Enabled {
			if err := s.Gateway.Validate(c); err != nil {
				return contract.PaymentConfiguration{}, ErrPaymentClosed
			}
			return c, nil
		}
	}
	return contract.PaymentConfiguration{}, ErrPaymentClosed
}

func (s *PaymentRuntime) Methods(ctx context.Context) ([]string, error) {
	if s == nil || s.Load == nil || s.Gateway == nil {
		return []string{}, nil
	}
	configs, err := s.Load(ctx)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, c := range configs {
		if !c.Enabled || s.Gateway.Validate(c) != nil {
			continue
		}
		if c.Provider == "easypay" {
			out = append(out, "easypay_alipay", "easypay_wechat")
		} else {
			out = append(out, c.Provider)
		}
	}
	return out, nil
}

func (s *PaymentRuntime) Launch(ctx context.Context, org int64, id string) (contract.CheckoutOrder, error) {
	o, err := s.Store.Get(ctx, org, id)
	if err != nil {
		return o, err
	}
	if o.Status != "pending" || contract.NoChannel(o.Provider) {
		return o, nil
	}
	c, err := s.Configuration(ctx, o.Provider)
	if err != nil {
		return o, err
	}
	if o.QRCode != nil || o.PayURL != nil || o.LaunchState != nil {
		return o, nil
	}
	o, claimed, err := s.Store.ClaimEntry(ctx, org, id)
	if err != nil || !claimed {
		return o, err
	}
	e, err := s.Gateway.Create(ctx, c, o)
	if err != nil {
		return o, err
	}
	if err = s.Store.SaveEntry(ctx, org, id, e); err != nil {
		return o, err
	}
	return s.Store.Get(ctx, org, id)
}
