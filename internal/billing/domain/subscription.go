package domain

import (
	"fmt"
	"math"
	"math/big"
	"time"
)

// MemberCap is the number of members every workspace may have. Members are
// not sold; the cap is global. db/migrations/00002_schema.sql hard-codes the
// same number in subscription_capacity, and the integration suite compares
// the two.
const MemberCap = 10

// StoreCap is the most stores one workspace may hold in a single paid period,
// one current seller key per store. db/migrations/00014 hard-codes the same
// number in the stores CHECK constraints, and the integration suite compares
// the two. store_limit_override is an administrator grant and is not bound by it.
const StoreCap = 100

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
	ActionKeep      = "keep"
)

// Quote refusal codes carried to HTTP.
const (
	CodeValidation         = "VALIDATION"
	CodeNothingToChange    = "NOTHING_TO_CHANGE"
	CodeRenewRequired      = "RENEW_REQUIRED"
	CodeCapacityBelowUsage = "CAPACITY_BELOW_USAGE"
	CodePendingOrderExists = "PENDING_ORDER_EXISTS"
	CodeQuoteExpired       = "QUOTE_EXPIRED"
	CodeQuoteStale         = "QUOTE_STALE"
	CodeStoreCapExceeded   = "STORE_CAP_EXCEEDED"
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

// PlanPrice is one row of the catalogue as the billing math sees it. A plan
// sells stores at its own unit price. Rank orders plans by feature level
// (plans.sort_order).
type PlanPrice struct {
	Key               string
	Rank              int
	StoreMonthlyCents int64
	Paid              bool // false for free: not purchasable
}

// Catalog is the pricing table.
type Catalog struct {
	Plans map[string]PlanPrice
}

// DefaultCatalog is the catalogue from docs/architecture/subscription-billing.md.
// The database is the source of truth once plans carries these values; this
// copy exists so the pricing core can be tested without a database.
func DefaultCatalog() Catalog {
	return Catalog{Plans: map[string]PlanPrice{
		PlanFree: {Key: PlanFree, Rank: 0},
		PlanLite: {Key: PlanLite, Rank: 1, StoreMonthlyCents: 2000, Paid: true},
		PlanPro:  {Key: PlanPro, Rank: 2, StoreMonthlyCents: 2500, Paid: true},
		PlanMax:  {Key: PlanMax, Rank: 3, StoreMonthlyCents: 3000, Paid: true},
	}}
}

// Plan returns the catalogue row for key.
func (c Catalog) Plan(key string) (PlanPrice, bool) {
	p, ok := c.Plans[key]
	return p, ok
}

func monthly(storeCents int64, stores int) (int64, error) {
	if stores < 1 || stores > math.MaxInt32 {
		return 0, invalid("店铺数量至少为 1")
	}
	amount := new(big.Int).Mul(big.NewInt(storeCents), big.NewInt(int64(stores)))
	if !amount.IsInt64() || amount.Sign() < 0 {
		return 0, invalid("金额超出可计费范围")
	}
	return amount.Int64(), nil
}

// Monthly is the monthly price of a store count on this plan.
func (p PlanPrice) Monthly(stores int) (int64, error) {
	return monthly(p.StoreMonthlyCents, stores)
}

// Monthly is what this paid period costs per month at its frozen unit price.
func (p Period) Monthly() (int64, error) {
	return monthly(p.StoreMonthlyCents, p.Stores)
}

// Target is an absolute capacity, never a delta. Members are not part of it.
type Target struct {
	PlanKey string `json:"plan_key"`
	Stores  int    `json:"stores"`
}

// Snapshot is the subscription state a quote is priced against.
type Snapshot struct {
	Status  string
	PlanKey string
	Stores  int
	TermEnd time.Time
	Anchor  time.Time
	Periods []Period
}

// Line is one row of a quote breakdown. Cents is that line rounded on its
// own; the total is the exact sum rounded once, so lines can differ from the
// total by at most one fen.
type Line struct {
	Label string
	Cents int64
}

// Quotation is a priced action. PlanKey and Stores are the capacity the client
// asked for; a change keeps the larger of that and what each paid period
// already holds (see Catalog.Upgrade).
type Quotation struct {
	Action              string
	TermStart           time.Time
	TermEnd             time.Time
	PlanKey             string `json:"plan_key"`
	Stores              int    `json:"stores"`
	Months              int
	AmountCents         int64
	Breakdown           []Line
	CouponCode          string
	CouponPercent       int
	CouponDiscountCents int64
	// FreeOnly marks a quote that costs nothing and creates no order: a keep-list edit.
	FreeOnly bool
}

// SubscribeTerm starts at purchase time and sells whole anniversary months.
func SubscribeTerm(now time.Time, months int) (start, end time.Time) {
	return now.In(Shanghai), TermEnd(now, months)
}

func RenewTerm(currentEnd time.Time, active bool, now time.Time, months int) (start, end time.Time) {
	start = now.In(Shanghai)
	if active && currentEnd.After(now) {
		start = currentEnd
	}
	return start, TermEnd(start, months)
}

// Period is an already purchased, non-overlapping capacity interval. The unit
// price is frozen at purchase, so a later catalogue change never reprices it.
type Period struct {
	ID    int64     `json:"id"`
	Start time.Time `json:"starts_at"`
	End   time.Time `json:"ends_at"`
	Target
	StoreMonthlyCents int64    `json:"store_monthly_cents"`
	KeepStores        []string `json:"keep_store_ids"`
}

// Upgrade is the period after a change: the higher-ranked plan and the larger
// store count. A change never shrinks a paid period, and a plan switch
// re-prices the period at the new plan's unit price.
func (c Catalog) Upgrade(p Period, t Target) (Period, error) {
	target, ok := c.Plans[t.PlanKey]
	if !ok {
		return Period{}, invalid("未知套餐 %q", t.PlanKey)
	}
	current, ok := c.Plans[p.PlanKey]
	if !ok {
		return Period{}, invalid("未知套餐 %q", p.PlanKey)
	}
	out := p
	if target.Rank > current.Rank {
		out.PlanKey = target.Key
		out.StoreMonthlyCents = target.StoreMonthlyCents
	}
	out.Stores = max(p.Stores, t.Stores)
	return out, nil
}

// AllowedMonths reports whether months is one of the sold terms.
func AllowedMonths(months int) bool {
	switch months {
	case 1, 3, 6, 12:
		return true
	}
	return false
}

// QuoteInput is everything the pricing core needs. KeepStores is the length of
// the caller's keep list; LiveStores is the current store count, used to
// require an explicit keep list before a reduction.
type QuoteInput struct {
	Now           time.Time
	Snapshot      Snapshot
	Action        string
	Target        Target
	Months        int
	KeepStores    int
	LiveStores    int
	CouponCode    string
	CouponPercent int
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
	case ActionKeep:
		if !in.Snapshot.TermEnd.After(now) {
			return Quotation{}, &QuoteError{Status: 402, Code: CodeRenewRequired, Message: "订阅已到期，请先续费"}
		}
		if err = paidTarget(cat, in.Target); err != nil {
			return Quotation{}, err
		}
		if err = fitsKeep(in.Target, in); err != nil {
			return Quotation{}, err
		}
		q = Quotation{Action: in.Action, PlanKey: in.Target.PlanKey, Stores: in.Target.Stores, Months: in.Months, TermStart: in.Snapshot.TermEnd, TermEnd: in.Snapshot.TermEnd, FreeOnly: true, Breakdown: []Line{{Label: "只调整保留名单，已付权益继续用满", Cents: 0}}}
	case ActionChange:
		q, err = quoteChange(cat, in, now)
	default:
		return Quotation{}, invalid("未知操作 %q", in.Action)
	}
	if err != nil {
		return Quotation{}, err
	}
	return applyDiscounts(q, in)
}

// quoteSubscribe sells whole service months from the payment anniversary.
func quoteSubscribe(cat Catalog, in QuoteInput, now time.Time) (Quotation, error) {
	if in.Snapshot.Status == StatusActive {
		return Quotation{}, &QuoteError{Status: 409, Code: CodeQuoteStale,
			Message: "工作区已有生效中的订阅，请使用续费"}
	}
	t := in.Target
	if err := paidTarget(cat, t); err != nil {
		return Quotation{}, err
	}
	base, err := cat.Plans[t.PlanKey].Monthly(t.Stores)
	if err != nil {
		return Quotation{}, err
	}
	q := Quotation{
		Action:  ActionSubscribe,
		PlanKey: t.PlanKey,
		Stores:  t.Stores,
		Months:  in.Months,
	}
	if base > math.MaxInt64/int64(in.Months) {
		return Quotation{}, invalid("金额超出可计费范围")
	}
	q.TermStart, q.TermEnd = SubscribeTerm(now, in.Months)
	q.AmountCents = base * int64(in.Months)
	q.Breakdown = []Line{{Label: fmt.Sprintf("自购买日起 ×%d 个月", in.Months), Cents: q.AmountCents}}

	return q, nil
}

func quoteRenew(cat Catalog, in QuoteInput, now time.Time) (Quotation, error) {
	if in.Snapshot.Status != StatusActive {
		return Quotation{}, &QuoteError{Status: 402, Code: CodeRenewRequired,
			Message: "订阅已到期，请先重新订阅"}
	}
	t := in.Target
	if err := paidTarget(cat, t); err != nil {
		return Quotation{}, err
	}
	if err := fitsKeep(t, in); err != nil {
		return Quotation{}, err
	}
	base, err := cat.Plans[t.PlanKey].Monthly(t.Stores)
	if err != nil {
		return Quotation{}, err
	}
	if base > math.MaxInt64/int64(in.Months) {
		return Quotation{}, invalid("金额超出可计费范围")
	}
	start, end := RenewTerm(in.Snapshot.TermEnd, true, now, in.Months)
	if !in.Snapshot.Anchor.IsZero() {
		end = AnchoredEnd(in.Snapshot.Anchor, start, in.Months)
	}
	q := Quotation{
		Action:      ActionRenew,
		TermStart:   start,
		TermEnd:     end,
		PlanKey:     t.PlanKey,
		Stores:      t.Stores,
		Months:      in.Months,
		AmountCents: base * int64(in.Months),
	}
	q.Breakdown = []Line{{Label: fmt.Sprintf("%s · %d 店，整月 ×%d", t.PlanKey, t.Stores, in.Months), Cents: q.AmountCents}}
	return q, nil
}

// quoteChange prices a capacity change that keeps the current term. Each paid
// period is upgraded (Catalog.Upgrade) and the monthly difference is charged,
// prorated to that period's end. A change that upgrades nothing is refused:
// capacity only goes down at renewal.
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
	if err := fitsKeep(t, in); err != nil {
		return Quotation{}, err
	}
	q := Quotation{Action: ActionChange, PlanKey: t.PlanKey, Stores: t.Stores,
		TermStart: now, TermEnd: in.Snapshot.TermEnd, Months: in.Months}
	periods := in.Snapshot.Periods
	anchor := in.Snapshot.Anchor
	if anchor.IsZero() {
		anchor = MonthStart(now)
	}
	if len(periods) == 0 {
		cur := cat.Plans[in.Snapshot.PlanKey]
		periods = []Period{{Start: now, End: in.Snapshot.TermEnd,
			Target:            Target{PlanKey: in.Snapshot.PlanKey, Stores: in.Snapshot.Stores},
			StoreMonthlyCents: cur.StoreMonthlyCents}}
	}
	total := new(big.Rat)
	for _, period := range periods {
		start := period.Start
		if now.After(start) {
			start = now
		}
		if !period.End.After(start) {
			continue
		}
		upgraded, err := cat.Upgrade(period, t)
		if err != nil {
			return Quotation{}, err
		}
		before, err := period.Monthly()
		if err != nil {
			return Quotation{}, err
		}
		after, err := upgraded.Monthly()
		if err != nil {
			return Quotation{}, err
		}
		unit := max(int64(0), after-before)
		fraction := PeriodFraction(unit, anchor, start, period.End)
		total.Add(total, fraction)
		if unit > 0 {
			q.Breakdown = append(q.Breakdown, Line{Label: fmt.Sprintf("%s 至 %s 容量补差", start.In(Shanghai).Format("2006-01-02 15:04"), period.End.In(Shanghai).Format("2006-01-02 15:04")), Cents: roundHalfUp(fraction)})
		}
	}
	if total.Cmp(new(big.Rat).SetInt64(math.MaxInt64)) > 0 {
		return Quotation{}, invalid("金额超出可计费范围")
	}
	q.AmountCents = roundHalfUp(total)
	if q.AmountCents == 0 {
		return Quotation{}, &QuoteError{Status: 409, Code: CodeNothingToChange,
			Message: "目标容量不高于已付容量，无需变更；减少容量请在续费时选择"}
	}
	return q, nil
}

func paidTarget(cat Catalog, t Target) error {
	p, ok := cat.Plans[t.PlanKey]
	if !ok {
		return invalid("未知套餐 %q", t.PlanKey)
	}
	if !p.Paid {
		return invalid("不能订阅免费档")
	}
	if t.Stores < 1 {
		return invalid("店铺数量至少为 1")
	}
	if t.Stores > StoreCap {
		return &QuoteError{Status: 400, Code: CodeStoreCapExceeded,
			Message: fmt.Sprintf("每个工作区最多购买 %d 家店铺", StoreCap)}
	}
	return nil
}

// fitsKeep rejects a target that cannot hold the caller's keep list. A
// reduction must name every store it wants to keep; the capacity must be at
// least that many.
func fitsKeep(t Target, in QuoteInput) error {
	if in.KeepStores > t.Stores {
		return &QuoteError{Status: 409, Code: CodeCapacityBelowUsage,
			Message: fmt.Sprintf("保留 %d 家店超出目标容量 %d", in.KeepStores, t.Stores)}
	}
	return nil
}
