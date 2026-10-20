package domain

import (
	"fmt"
	"time"
)

// Plan keys. The catalogue lives in plans; these are the only keys the
// subscription path accepts as a paid target.
const (
	PlanFree = "free"
	PlanLite = "lite"
	PlanPro  = "pro"
	PlanMax  = "max"
)

// Subscription statuses stored on subscriptions.status.
const (
	StatusFree    = "free"
	StatusActive  = "active"
	StatusExpired = "expired"
)

// Quote actions.
const (
	ActionSubscribe = "subscribe"
	ActionRenew     = "renew"
	ActionChange    = "change"
)

// Quote refusal codes carried to HTTP.
const (
	CodeValidation         = "VALIDATION"
	CodeRenewRequired      = "RENEW_REQUIRED"
	CodeCapacityBelowUsage = "CAPACITY_BELOW_USAGE"
	CodePendingOrderExists = "PENDING_ORDER_EXISTS"
	CodeQuoteExpired       = "QUOTE_EXPIRED"
	CodeQuoteStale         = "QUOTE_STALE"
)

// QuoteError is a client refusal with an HTTP status and a screaming code.
// It mirrors RedeemError so the billing HTTP layer has one shape to render.
type QuoteError struct {
	Status  int
	Code    string
	Message string
}

func (e *QuoteError) Error() string { return e.Message }

func invalid(format string, args ...any) *QuoteError {
	return &QuoteError{Status: 400, Code: CodeValidation, Message: fmt.Sprintf(format, args...)}
}

// PlanPrice is one row of the catalogue as the billing math sees it.
type PlanPrice struct {
	Key          string
	MonthlyCents int64
	Stores       int
	Members      int
	Addons       bool // false for free: no extra stores or members
}

// Catalog is the pricing table. StoreMonthlyCents and MemberMonthlyCents are
// global; every paid plan sells add-ons at the same unit price.
type Catalog struct {
	Plans              map[string]PlanPrice
	StoreMonthlyCents  int64
	MemberMonthlyCents int64
}

// DefaultCatalog is the catalogue from docs/architecture/subscription-billing.md.
// The database is the source of truth once plans carries these values; this
// copy exists so the pricing core can be tested without a database.
func DefaultCatalog() Catalog {
	return Catalog{
		Plans: map[string]PlanPrice{
			PlanFree: {Key: PlanFree, MonthlyCents: 0, Stores: 1, Members: 1, Addons: false},
			PlanLite: {Key: PlanLite, MonthlyCents: 10000, Stores: 5, Members: 1, Addons: true},
			PlanPro:  {Key: PlanPro, MonthlyCents: 60000, Stores: 30, Members: 6, Addons: true},
			PlanMax:  {Key: PlanMax, MonthlyCents: 100000, Stores: 50, Members: 11, Addons: true},
		},
		StoreMonthlyCents:  2000,
		MemberMonthlyCents: 3000,
	}
}

// Plan returns the catalogue row for key.
func (c Catalog) Plan(key string) (PlanPrice, bool) {
	p, ok := c.Plans[key]
	return p, ok
}

// Base is the monthly price of a capacity: the plan fee plus every add-on.
// Callers pass current values for renewal without a schedule and target
// values for a capacity change.
func (c Catalog) Base(planKey string, extraStores, extraMembers int) (int64, error) {
	p, ok := c.Plans[planKey]
	if !ok {
		return 0, invalid("未知套餐 %q", planKey)
	}
	if extraStores < 0 || extraMembers < 0 {
		return 0, invalid("加购数量不能为负")
	}
	if !p.Addons && (extraStores > 0 || extraMembers > 0) {
		return 0, invalid("免费档不能加购")
	}
	return p.MonthlyCents + c.StoreMonthlyCents*int64(extraStores) + c.MemberMonthlyCents*int64(extraMembers), nil
}

// Target is an absolute capacity, never a delta.
type Target struct {
	PlanKey      string
	ExtraStores  int
	ExtraMembers int
}

// Snapshot is the subscription state a quote is priced against.
type Snapshot struct {
	Status           string
	PlanKey          string
	ExtraStores      int
	ExtraMembers     int
	TermEnd          time.Time
	NextPlanKey      string
	NextExtraStores  int
	NextExtraMembers int
}

// scheduled reports whether a renewal should be priced on next_* rather than
// the current capacity. next_plan_key is the marker: a scheduled reduction
// always writes it, even when it repeats the current plan. Treating a zero
// next_extra_stores as "no schedule" would price every workspace that has
// add-ons as if it had scheduled a reduction to zero.
func (s Snapshot) scheduled() bool { return s.NextPlanKey != "" }

// RenewalTarget is the capacity the next term is sold at.
func (s Snapshot) RenewalTarget() Target {
	if !s.scheduled() {
		return Target{PlanKey: s.PlanKey, ExtraStores: s.ExtraStores, ExtraMembers: s.ExtraMembers}
	}
	return Target{PlanKey: s.NextPlanKey, ExtraStores: s.NextExtraStores, ExtraMembers: s.NextExtraMembers}
}

// Line is one row of a quote breakdown. Cents is that line rounded on its
// own; the total is the exact sum rounded once, so lines can differ from the
// total by at most one fen.
type Line struct {
	Label string
	Cents int64
}

// Quotation is a priced action.
type Quotation struct {
	Action       string
	TermStart    time.Time
	TermEnd      time.Time
	PlanKey      string
	ExtraStores  int
	ExtraMembers int
	PlanStores   int
	PlanMembers  int
	Months       int
	AmountCents  int64
	Breakdown    []Line
	// ScheduleOnly marks a change whose amount is zero: a pure reduction that
	// takes effect at term_end. It writes subscriptions.next_* instead of
	// creating an order.
	ScheduleOnly bool
}

// Stores is the total store capacity after the quote.
func (q Quotation) Stores() int { return q.PlanStores + q.ExtraStores }

// Members is the total member capacity after the quote.
func (q Quotation) Members() int { return q.PlanMembers + q.ExtraMembers }

// SetPlanCapacity records the catalogue row's base capacity on the quote, so
// callers do not have to re-read the catalogue to render totals.
func (q *Quotation) SetPlanCapacity(stores, members int) {
	q.PlanStores, q.PlanMembers = stores, members
}

// SubscribeTerm is the term a first purchase or a reopen buys. Pricing and
// fulfillment both call it so a quote can never disagree with what is booked.
func SubscribeTerm(now time.Time, months int) (start, end time.Time) {
	now = now.In(Shanghai)
	stubEnd := NextMonthStart(now)
	if stubEnd.Sub(now) < 24*time.Hour {
		return stubEnd, TermEnd(stubEnd, months)
	}
	return now, TermEnd(stubEnd, months-1)
}

// RenewTerm is the term a renewal buys. It appends to the current end when
// that end is still in the future, and starts fresh otherwise.
func RenewTerm(currentEnd time.Time, active bool, now time.Time, months int) (start, end time.Time) {
	start = now
	if active && currentEnd.After(now) {
		start = currentEnd
	}
	start = MonthStart(start)
	return start, TermEnd(start, months)
}

// AllowedMonths reports whether months is one of the sold terms.
func AllowedMonths(months int) bool {
	switch months {
	case 1, 3, 6, 12:
		return true
	}
	return false
}

// QuoteInput is everything the pricing core needs. KeepStores and KeepMembers
// are the lengths of the caller's keep lists; LiveStores and LiveMembers are
// the current counts, used to require an explicit keep list before a
// reduction.
type QuoteInput struct {
	Now         time.Time
	Snapshot    Snapshot
	Action      string
	Target      Target
	Months      int
	KeepStores  int
	KeepMembers int
	LiveStores  int
	LiveMembers int
}

// Quote prices one action. The amount is the exact rational sum of every
// component rounded half-up once.
func Quote(cat Catalog, in QuoteInput) (Quotation, error) {
	if !AllowedMonths(in.Months) {
		return Quotation{}, invalid("购买月数只能是 1/3/6/12")
	}
	now := in.Now.In(Shanghai)
	var q Quotation
	var err error
	switch in.Action {
	case ActionSubscribe:
		q, err = quoteSubscribe(cat, in, now)
	case ActionRenew:
		q, err = quoteRenew(cat, in, now)
	case ActionChange:
		q, err = quoteChange(cat, in, now)
	default:
		return Quotation{}, invalid("未知操作 %q", in.Action)
	}
	if err != nil {
		return Quotation{}, err
	}
	if p, ok := cat.Plans[q.PlanKey]; ok {
		q.SetPlanCapacity(p.Stores, p.Members)
	}
	return q, nil
}

// quoteSubscribe prices a first purchase or a reopen of an expired workspace.
//
// The first stretch runs to the next month boundary. When less than a day
// remains it is not prorated at all: the term starts on the 1st and the user
// pays whole months. Otherwise 10-31 23:59 would buy ten seconds of time.
func quoteSubscribe(cat Catalog, in QuoteInput, now time.Time) (Quotation, error) {
	if in.Snapshot.Status == StatusActive {
		return Quotation{}, &QuoteError{Status: 409, Code: CodeQuoteStale,
			Message: "工作区已有生效中的订阅，请使用续费"}
	}
	t := in.Target
	if err := paidTarget(cat, t); err != nil {
		return Quotation{}, err
	}
	base, err := cat.Base(t.PlanKey, t.ExtraStores, t.ExtraMembers)
	if err != nil {
		return Quotation{}, err
	}
	q := Quotation{
		Action:       ActionSubscribe,
		PlanKey:      t.PlanKey,
		ExtraStores:  t.ExtraStores,
		ExtraMembers: t.ExtraMembers,
		Months:       in.Months,
	}
	q.TermStart, q.TermEnd = SubscribeTerm(now, in.Months)
	if NextMonthStart(now).Sub(now) < 24*time.Hour {
		q.AmountCents = base * int64(in.Months)
		q.Breakdown = []Line{{Label: fmt.Sprintf("整月 ×%d（本月剩余不足一天，自下月 1 日起算）", in.Months), Cents: q.AmountCents}}
		return q, nil
	}
	stubEnd := NextMonthStart(now)
	// Prorate rounds once over this stretch; the whole months after it are
	// exact. Pricing the two parts with one rounding would need a rational
	// total with two different denominators, so the stub is rounded on its
	// own and the whole months are added exactly.
	stub := Prorate(base, now, stubEnd)
	whole := base * int64(in.Months-1)
	q.AmountCents = stub + whole
	q.Breakdown = []Line{
		{Label: fmt.Sprintf("本月剩余 %d/%d 天", dateDays(now, stubEnd), daysInMonth(now)), Cents: stub},
	}
	if whole > 0 {
		q.Breakdown = append(q.Breakdown, Line{Label: fmt.Sprintf("整月 ×%d", in.Months-1), Cents: whole})
	}
	if q.AmountCents <= 0 {
		return Quotation{}, invalid("金额不足一分")
	}
	return q, nil
}

func quoteRenew(cat Catalog, in QuoteInput, now time.Time) (Quotation, error) {
	if in.Snapshot.Status != StatusActive {
		return Quotation{}, &QuoteError{Status: 402, Code: CodeRenewRequired,
			Message: "订阅已到期，请先重新订阅"}
	}
	t := in.Snapshot.RenewalTarget()
	if err := paidTarget(cat, t); err != nil {
		return Quotation{}, err
	}
	base, err := cat.Base(t.PlanKey, t.ExtraStores, t.ExtraMembers)
	if err != nil {
		return Quotation{}, err
	}
	start, end := RenewTerm(in.Snapshot.TermEnd, true, now, in.Months)
	q := Quotation{
		Action:       ActionRenew,
		TermStart:    start,
		TermEnd:      end,
		PlanKey:      t.PlanKey,
		ExtraStores:  t.ExtraStores,
		ExtraMembers: t.ExtraMembers,
		Months:       in.Months,
		AmountCents:  base * int64(in.Months),
	}
	label := fmt.Sprintf("%s + %d 店 + %d 人，整月 ×%d",
		t.PlanKey, t.ExtraStores, t.ExtraMembers, in.Months)
	if in.Snapshot.scheduled() {
		label += "（按预约降级后容量）"
	}
	q.Breakdown = []Line{{Label: label, Cents: q.AmountCents}}
	return q, nil
}

// quoteChange prices a capacity change that keeps the current term. Only the
// increases are charged, prorated to term_end. A reduction is free and lands
// at term_end through subscriptions.next_*.
func quoteChange(cat Catalog, in QuoteInput, now time.Time) (Quotation, error) {
	if in.Snapshot.Status != StatusActive {
		return Quotation{}, &QuoteError{Status: 402, Code: CodeRenewRequired,
			Message: "订阅已到期，请先续费再变更容量"}
	}
	if !in.Snapshot.TermEnd.After(now) {
		return Quotation{}, &QuoteError{Status: 402, Code: CodeRenewRequired,
			Message: "订阅已到期，请先续费再变更容量"}
	}
	t := in.Target
	if err := paidTarget(cat, t); err != nil {
		return Quotation{}, err
	}
	if err := fitsKeep(cat, t, in); err != nil {
		return Quotation{}, err
	}
	cur := Target{
		PlanKey:      in.Snapshot.PlanKey,
		ExtraStores:  in.Snapshot.ExtraStores,
		ExtraMembers: in.Snapshot.ExtraMembers,
	}
	curPlan, ok := cat.Plans[cur.PlanKey]
	if !ok {
		return Quotation{}, invalid("当前套餐 %q 不在目录中", cur.PlanKey)
	}
	tgtPlan, ok := cat.Plans[t.PlanKey]
	if !ok {
		return Quotation{}, invalid("未知套餐 %q", t.PlanKey)
	}
	upgradeUnit := tgtPlan.MonthlyCents - curPlan.MonthlyCents
	if upgradeUnit < 0 {
		upgradeUnit = 0
	}
	storeUnit := cat.StoreMonthlyCents * int64(max(0, t.ExtraStores-cur.ExtraStores))
	memberUnit := cat.MemberMonthlyCents * int64(max(0, t.ExtraMembers-cur.ExtraMembers))

	q := Quotation{
		Action:       ActionChange,
		TermStart:    in.Snapshot.TermEnd,
		TermEnd:      in.Snapshot.TermEnd,
		PlanKey:      t.PlanKey,
		ExtraStores:  t.ExtraStores,
		ExtraMembers: t.ExtraMembers,
		Months:       in.Months,
	}
	// One rational sum, one rounding.
	q.AmountCents = prorateSum([]int64{upgradeUnit, storeUnit, memberUnit}, now, in.Snapshot.TermEnd)
	if upgradeUnit > 0 {
		q.Breakdown = append(q.Breakdown, Line{
			Label: fmt.Sprintf("%s→%s", cur.PlanKey, t.PlanKey),
			Cents: Prorate(upgradeUnit, now, in.Snapshot.TermEnd),
		})
	}
	if storeUnit > 0 {
		q.Breakdown = append(q.Breakdown, Line{
			Label: fmt.Sprintf("+%d 店", t.ExtraStores-cur.ExtraStores),
			Cents: Prorate(storeUnit, now, in.Snapshot.TermEnd),
		})
	}
	if memberUnit > 0 {
		q.Breakdown = append(q.Breakdown, Line{
			Label: fmt.Sprintf("+%d 人", t.ExtraMembers-cur.ExtraMembers),
			Cents: Prorate(memberUnit, now, in.Snapshot.TermEnd),
		})
	}
	if q.AmountCents == 0 {
		// Zero means there is nothing to charge: the plan fee did not rise and
		// no add-on grew. That covers a pure reduction and also a sideways move
		// between plans of equal price. It books a schedule, never an order.
		q.ScheduleOnly = true
		q.Breakdown = []Line{{Label: "在到期日生效，不退款", Cents: 0}}
		return q, nil
	}
	if q.AmountCents < 0 {
		return Quotation{}, invalid("金额不能为负")
	}
	return q, nil
}

func paidTarget(cat Catalog, t Target) error {
	p, ok := cat.Plans[t.PlanKey]
	if !ok {
		return invalid("未知套餐 %q", t.PlanKey)
	}
	if !p.Addons {
		return invalid("不能订阅免费档")
	}
	if t.ExtraStores < 0 || t.ExtraMembers < 0 {
		return invalid("加购数量不能为负")
	}
	return nil
}

// fitsKeep rejects a target that cannot hold the caller's keep lists. A
// reduction must name every store and member it wants to keep; the capacity
// must be at least that many.
func fitsKeep(cat Catalog, t Target, in QuoteInput) error {
	p, ok := cat.Plans[t.PlanKey]
	if !ok {
		return invalid("未知套餐 %q", t.PlanKey)
	}
	stores := p.Stores + t.ExtraStores
	members := p.Members + t.ExtraMembers
	if in.KeepStores > stores {
		return &QuoteError{Status: 409, Code: CodeCapacityBelowUsage,
			Message: fmt.Sprintf("保留 %d 家店超出目标容量 %d", in.KeepStores, stores)}
	}
	if in.KeepMembers > members {
		return &QuoteError{Status: 409, Code: CodeCapacityBelowUsage,
			Message: fmt.Sprintf("保留 %d 名成员超出目标容量 %d", in.KeepMembers, members)}
	}
	return nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
