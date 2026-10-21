package contract

import (
	"context"
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
	PlanKey      string `json:"plan_key"`
	ExtraStores  int    `json:"extra_stores"`
	ExtraMembers int    `json:"extra_members"`
}

// QuoteRequest is the client's intent.
type QuoteRequest struct {
	ExpectedWorkspace string   `json:"expected_workspace_uuid"`
	Action            string   `json:"action"`
	Target            Target   `json:"target"`
	Months            int      `json:"months"`
	KeepStores        []string `json:"keep_store_ids"`
	KeepMembers       []int64  `json:"keep_member_ids"`
	PeriodID          int64    `json:"period_id,omitempty"`
	RenewWithChange   *bool    `json:"renew_with_change,omitempty"`
}

// Capacity is a used/limit pair on the plan screen.
type Capacity struct {
	Used  int `json:"used"`
	Limit int `json:"limit"`
}

// NextTerm is a scheduled capacity change, applied at term_end.
type NextTerm struct {
	EffectiveAt  *time.Time `json:"effective_at,omitempty"`
	ExtraStores  int        `json:"extra_stores"`
	ExtraMembers int        `json:"extra_members"`
	KeepStores   []string   `json:"keep_store_ids"`
	KeepMembers  []int64    `json:"keep_member_ids"`
	PlanKey      string     `json:"plan_key"`
	Stores       int        `json:"stores"`
	Members      int        `json:"members"`
}

// Renewal is what one more month costs at the scheduled capacity.
type Renewal struct {
	Months      int    `json:"months"`
	AmountCents int64  `json:"amount_cents"`
	Breakdown   []Line `json:"breakdown,omitempty"`
}

// View is the plan screen payload.
type Period struct {
	ID       int64     `json:"id"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
	Target
	Stores      int      `json:"stores"`
	Members     int      `json:"members"`
	KeepStores  []string `json:"keep_store_ids"`
	KeepMembers []int64  `json:"keep_member_ids"`
}

type StoreChoice struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	ManualDisabled bool   `json:"manual_disabled"`
	Allowed        bool   `json:"allowed"`
}

type Plan struct {
	Key          string `json:"key"`
	MonthlyCents int64  `json:"monthly_cents"`
	Stores       int    `json:"stores"`
	Members      int    `json:"members"`
}

type MemberChoice struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Owner bool   `json:"owner"`
}

type View struct {
	MemberChoices []MemberChoice `json:"member_choices"`

	Revision           int64         `json:"revision"`
	ExtraStores        int           `json:"extra_stores"`
	ExtraMembers       int           `json:"extra_members"`
	CurrentEnd         *time.Time    `json:"current_end"`
	Periods            []Period      `json:"periods"`
	StoreChoices       []StoreChoice `json:"store_choices"`
	Plans              []Plan        `json:"plans"`
	StoreMonthlyCents  int64         `json:"store_monthly_cents"`
	MemberMonthlyCents int64         `json:"member_monthly_cents"`
	PendingPublicID    string        `json:"pending_public_id,omitempty"`

	PlanKey      string     `json:"plan_key"`
	Status       string     `json:"status"`
	TermStart    *time.Time `json:"term_start"`
	TermEnd      *time.Time `json:"term_end"`
	Stores       Capacity   `json:"stores"`
	Members      Capacity   `json:"members"`
	Next         *NextTerm  `json:"next,omitempty"`
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
	Members int    `json:"members"`
}

// Offered is a priced quote as returned to the client.
type Offered struct {
	EffectiveAt        *time.Time `json:"effective_at"`
	KeepStores         []string   `json:"keep_store_ids"`
	Renewal            Target     `json:"renewal"`
	RenewalAmountCents int64      `json:"renewal_amount_cents"`
	TermEnd            *time.Time `json:"term_end"`

	ID           string         `json:"quote_id,omitempty"`
	ExpiresAt    *time.Time     `json:"expires_at,omitempty"`
	Revision     int64          `json:"revision"`
	Action       string         `json:"action"`
	Current      QuoteCurrent   `json:"current"`
	Target       QuoteTargetOut `json:"target"`
	AmountCents  int64          `json:"amount_cents"`
	Breakdown    []Line         `json:"breakdown"`
	ScheduleOnly bool           `json:"schedule_only"`
}

// OrderBrief is what creating an order returns.
type OrderBrief struct {
	ID                int64      `json:"order_id"`
	PublicID          string     `json:"public_id"`
	PaymentDeadlineAt *time.Time `json:"payment_deadline_at,omitempty"`
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

// FulfillSubscriptionOrder is installed by billing for the administrative payment confirmation path.
var FulfillSubscriptionOrder func(context.Context, any, string, time.Time) error
