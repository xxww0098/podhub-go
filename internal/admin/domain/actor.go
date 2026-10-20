package domain

import (
	billingcontract "github.com/xxww0098/podhub-go/internal/admin/billing/contract"
	observecontract "github.com/xxww0098/podhub-go/internal/admin/observe/contract"
)

// Standing is the TOTP row for this session.
type Standing struct {
	Missing  bool
	Enrolled bool
	Elevated bool
}

// PaymentReplace is the decoded replace body after the handler's JSON check.
type PaymentReplace struct {
	Expected int64
	Slots    []PaymentSlot
}

// ErrorFilter is a validated error-log query.
type ErrorFilter struct {
	Query ErrorQuery
}

// ErrorDelete is the selected event keys. Each pair is event id, device uid.
type ErrorDelete struct {
	Events [][2]string
}

// The observation types live in the observe contract; these aliases keep the
// admin names.
type (
	Scope        = observecontract.Scope
	ProductQuery = observecontract.ProductQuery
	Thumbnail    = observecontract.Thumbnail
	ImageBytes   = observecontract.ImageBytes
)

// The billing request types live in the billing contract; these aliases keep
// the admin names.
type (
	RedeemSpec = billingcontract.RedeemSpec
	TopupGrant = billingcontract.TopupGrant
)
