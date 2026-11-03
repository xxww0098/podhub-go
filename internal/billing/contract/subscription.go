package contract

import (
	"time"
)

// Line is one row of a quote breakdown. Cents is that line rounded on its
// own; the total is the exact sum rounded once, so a line can differ from the
// total by at most one fen.
type Line struct {
	Label string `json:"label"`
	Cents int64  `json:"cents"`
}

// Target is an absolute capacity, never a delta.
type Target struct {
	PlanKey string `json:"plan_key"`
	Stores  int    `json:"stores"`
}

// QuoteRequest is the client's intent.
type QuoteRequest struct {
	ExpectedWorkspace string   `json:"expected_workspace_uuid"`
	Action            string   `json:"action"`
	Target            Target   `json:"target"`
	Months            int      `json:"months"`
	KeepStores        []string `json:"keep_store_ids"`
	PeriodID          int64    `json:"period_id,omitempty"`
	CouponCode        string   `json:"coupon_code,omitempty"`
}

// Capacity is a used/limit pair on the plan screen.
type Capacity struct {
	Used  int `json:"used"`
	Limit int `json:"limit"`
}

// Renewal is what one more month costs if the workspace renews as it is.
type Renewal struct {
	PlanKey     string `json:"plan_key"`
	Stores      int    `json:"stores"`
	Months      int    `json:"months"`
	AmountCents int64  `json:"amount_cents"`
	Breakdown   []Line `json:"breakdown,omitempty"`
}

// View is the plan screen payload.
type Period struct {
	ID         int64     `json:"id"`
	StartsAt   time.Time `json:"starts_at"`
	EndsAt     time.Time `json:"ends_at"`
	PlanKey    string    `json:"plan_key"`
	Stores     int       `json:"stores"`
	KeepStores []string  `json:"keep_store_ids"`
}

type StoreChoice struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	ManualDisabled bool   `json:"manual_disabled"`
	Allowed        bool   `json:"allowed"`
}

type Plan struct {
	Key               string `json:"key"`
	StoreMonthlyCents int64  `json:"store_monthly_cents"`
}

type View struct {
	Revision        int64         `json:"revision"`
	CurrentEnd      *time.Time    `json:"current_end"`
	Periods         []Period      `json:"periods"`
	StoreChoices    []StoreChoice `json:"store_choices"`
	Plans           []Plan        `json:"plans"`
	PendingPublicID string        `json:"pending_public_id,omitempty"`
	// PendingProvider is 'unselected' for an auto-issued renewal that still
	// needs a payment channel.
	PendingProvider    string     `json:"pending_provider,omitempty"`
	PendingAmountCents int64      `json:"pending_amount_cents,omitempty"`
	PendingDeadlineAt  *time.Time `json:"pending_deadline_at,omitempty"`
	AutoRenew          bool       `json:"auto_renew"`
	// Frozen is true when paid service ended and no store may run new work.
	Frozen   bool `json:"frozen"`
	StoreCap int  `json:"store_cap"`

	PlanKey      string     `json:"plan_key"`
	Status       string     `json:"status"`
	TermStart    *time.Time `json:"term_start"`
	TermEnd      *time.Time `json:"term_end"`
	Stores       Capacity   `json:"stores"`
	Members      Capacity   `json:"members"`
	NextRenewal  *Renewal   `json:"next_renewal,omitempty"`
	Draining     bool       `json:"draining"`
	PendingOrder bool       `json:"pending_order"`
}

// QuoteCurrent is the workspace state a quote was priced against.
type QuoteCurrent struct {
	PlanKey string     `json:"plan_key"`
	Stores  int        `json:"stores"`
	Members int        `json:"members"`
	TermEnd *time.Time `json:"term_end"`
}

// QuoteTargetOut is the capacity the quote would leave in place.
type QuoteTargetOut struct {
	PlanKey string `json:"plan_key"`
	Stores  int    `json:"stores"`
}

// Offered is a priced quote as returned to the client.
type Offered struct {
	EffectiveAt *time.Time `json:"effective_at"`
	KeepStores  []string   `json:"keep_store_ids"`
	TermEnd     *time.Time `json:"term_end"`

	ID          string         `json:"quote_id,omitempty"`
	ExpiresAt   *time.Time     `json:"expires_at,omitempty"`
	Revision    int64          `json:"revision"`
	Action      string         `json:"action"`
	Current     QuoteCurrent   `json:"current"`
	Target      QuoteTargetOut `json:"target"`
	AmountCents int64          `json:"amount_cents"`
	Breakdown   []Line         `json:"breakdown"`
	FreeOnly    bool           `json:"free_only"`
	Coupon      *AppliedCoupon `json:"coupon,omitempty"`
}

type AppliedCoupon struct {
	Code            string `json:"code"`
	DiscountPercent int    `json:"discount_percent"`
	DiscountCents   int64  `json:"discount_cents"`
}

// OrderBrief is what creating an order returns.
type OrderBrief struct {
	ID                int64      `json:"order_id"`
	PublicID          string     `json:"public_id"`
	PaymentDeadlineAt *time.Time `json:"payment_deadline_at,omitempty"`
	Provider          string     `json:"provider,omitempty"`
	EntryState        string     `json:"entry_state,omitempty"`
	QRCode            *string    `json:"qr_code,omitempty"`
	PayURL            *string    `json:"pay_url,omitempty"`
}

// Order is the subset of payment_orders the subscription path needs.
type Order struct {
	ID                   int64
	OrgID                int64
	PublicID             string
	Product              string
	AmountCents          int64
	Currency             string
	Provider             string
	Status               string
	Plan                 string
	Months               int
	SubscriptionSnapshot []byte
	PurchaseAgreement    []byte
	CreatedBy            int64
}
