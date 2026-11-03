package service

import (
	"context"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"time"
)

type PaymentStore interface {
	Get(context.Context, int64, string) (contract.CheckoutOrder, error)
	List(context.Context, int64, string, int64, int) ([]contract.CheckoutOrder, error)
	CreateTopup(context.Context, int64, int64, string, string, string, string, int64, time.Time) (contract.CheckoutOrder, error)
	ClaimEntry(context.Context, int64, string) (contract.CheckoutOrder, bool, error)
	SaveEntry(context.Context, int64, string, contract.PaymentEntry) error
	Cancel(context.Context, int64, string) error
}

type PaymentGateway interface {
	Validate(contract.PaymentConfiguration) error
	Create(context.Context, contract.PaymentConfiguration, contract.CheckoutOrder) (contract.PaymentEntry, error)
	Query(context.Context, contract.PaymentConfiguration, contract.CheckoutOrder) (*domain.Notice, error)
	Close(context.Context, contract.PaymentConfiguration, contract.CheckoutOrder) error
}
