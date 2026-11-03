package contract

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var ErrPaymentClosed = errors.New("payment channel unavailable")

// PaymentConfiguration is private server configuration; never serialize it.
type PaymentConfiguration struct {
	Provider string
	Enabled  bool
	Values   map[string]string
}

type PaymentConfigurations func(context.Context) ([]PaymentConfiguration, error)

// CheckoutOrder keeps provider entry state with the persisted money facts.
type CheckoutOrder struct {
	ID, OrgID, UserID                                          int64
	PublicID, OperationID, Product, Provider, Currency, Status string
	AmountCents, TopupMicrofen                                 int64
	Plan                                                       string
	Months                                                     int
	QRCode, PayURL, ProviderRef, LaunchState                   *string
	CreatedAt                                                  time.Time
	PaidAt, CanceledAt, Deadline                               *time.Time
	Agreement                                                  json.RawMessage
}

// ProviderUnselected marks an auto-issued renewal order whose buyer has not
// chosen a payment channel yet.
const ProviderUnselected = "unselected"

// NoChannel reports a provider that has no external payment session: manual
// orders are settled by an administrator, unselected ones are not payable yet.
func NoChannel(provider string) bool {
	return provider == "manual" || provider == ProviderUnselected
}

func (o CheckoutOrder) EntryState() string {
	if o.Status != "pending" {
		return "closed"
	}
	if o.Provider == ProviderUnselected {
		return ProviderUnselected
	}
	if o.Provider == "manual" {
		return "manual"
	}
	if o.QRCode != nil || o.PayURL != nil {
		return "ready"
	}
	if o.LaunchState != nil {
		return *o.LaunchState
	}
	return "entry_unknown"
}

type PaymentEntry struct {
	QRCode, PayURL, Reference string
}
