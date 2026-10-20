package domain

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// The product-sync state machine. Everything here is pure: the runner reads a
// snapshot, asks these functions what to do, and executes the answer. The
// vocabulary (`pass`, `hold`, the reason codes) is a table contract — the
// migration's CHECK constraints pin it, so a typo here fails a write rather
// than silently parking a store.
const (
	// PassNone is an idle row: done, or resting between slots.
	PassNone = "none"
	// PassListLive is the live listing walk.
	PassListLive = "list_live"
	// PassListArchived is the archived listing walk.
	PassListArchived = "list_archived"
	// PassDetail is the detail (info/list) chunk walk.
	PassDetail = "detail"
	// PassCommit is the whole-or-nothing generation commit.
	PassCommit = "commit"

	// HoldNone is a row free to spend.
	HoldNone = "none"
	// HoldYield gives the store's own Seller writes the budget first.
	HoldYield = "yield"
	// HoldBackoff paces retries after Seller refusals.
	HoldBackoff = "backoff"
	// HoldBudget is the day's reconcile ledger spent.
	HoldBudget = "budget"
	// HoldCooldown is a breaker or the 24 h failure streak.
	HoldCooldown = "cooldown"
	// HoldCredential parks a store whose key Ozon refused.
	HoldCredential = "credential"
	// HoldDisabled parks a store that is gone, disabled, or suspended.
	HoldDisabled = "disabled"
)

// The `hold_reason` vocabulary. The migration's CHECK constraint lists exactly
// these; a reason outside the set is a failed write.
const (
	ReasonRateLimited       = "rate_limited"
	ReasonGenerationExpired = "generation_expired"
	ReasonCredentialRevoked = "credential_revoked"
	ReasonCredentialExpired = "credential_expired"
	ReasonIPRestricted      = "ip_restricted"
	ReasonWorkspaceBreaker  = "workspace_breaker"
	ReasonDeploymentBreaker = "deployment_breaker"
	ReasonEgressBlocked     = "egress_blocked"
	ReasonStoreBusy         = "store_busy"
	ReasonSellerError       = "seller_error"
	ReasonBudgetExhausted   = "budget_exhausted"
	ReasonStoreDisabled     = "store_disabled"
	ReasonStagingLost       = "staging_lost"
)

// The schedule constants. Each one is a policy the runner enforces before a
// Seller call leaves this process.
const (
	// FailureCooldownMS parks a store after the streak below.
	FailureCooldownMS = int64(24 * 60 * 60 * 1000)
	// BreakerWindowMS is how far back the breaker scans look.
	BreakerWindowMS = int64(15 * 60 * 1000)
	// BreakerCooldownMS is how long an open breaker cools its scope.
	BreakerCooldownMS = int64(60 * 60 * 1000)
	// ConsecutiveFailureLimit is the streak that earns the cooldown.
	ConsecutiveFailureLimit = 3
	// GenerationMaxAgeMS voids a generation that never committed.
	GenerationMaxAgeMS = 3 * ReconcileIntervalMS
	// ManualAutoSkipMS is the window a just-finished press covers.
	ManualAutoSkipMS = int64(30 * 60 * 1000)
	// ListPageLimit is Ozon's documented page ceiling: a budget counts calls,
	// so the widest page is the cheapest walk.
	ListPageLimit = int64(1000)
	// ChainWatchdogMS is the lease a landing writes, and the rescan deadline
	// the row carries while a chain is in flight.
	ChainWatchdogMS = int64(10 * 60 * 1000)
	// JobTimeBudgetMS bounds one claimed Job's in-process loop.
	JobTimeBudgetMS = int64(10 * 60 * 1000)
	// YieldDeferMS is how long a busy store defers the mirror.
	YieldDeferMS = int64(5 * 60 * 1000)
	// MaxRetryAfterMS caps how long Ozon's Retry-After is honored.
	MaxRetryAfterMS = int64(30 * 60 * 1000)

	// moscowOffsetMS is the UTC+3 offset the day key and the midnight use.
	moscowOffsetMS = int64(3 * 60 * 60 * 1000)
	baseBackoffMS  = int64(60_000)
	maxBackoffMS   = int64(30 * 60 * 1000)
	msPerDay       = int64(24 * 60 * 60 * 1000)
)

// SyncSnapshot is the row plus the store facts one sync wake decides from. It
// is the same read the manual press and the verify path take, so a store can
// never be "due" to one caller and "held" to another.
type SyncSnapshot struct {
	StoreUUID string
	StorePK   int64
	OrgID     int64
	// SubmitterUserID is who the day's ledger is charged to: the org owner,
	// because the system has no user of its own.
	SubmitterUserID    int64
	RefreshGeneration  int64
	Pass               string
	Hold               string
	HoldUntilMS        *int64
	HoldReason         *string
	CursorLastID       *string
	CountTotal         *int64
	CountArchived      *int64
	ConsecutiveFailure int
	GenerationStartMS  *int64
	CallsDay           *string
	CallsReconcile     int
	CallsManual        int
	PassPagesLive      int
	PassPagesArchived  int
	NextDueMS          *int64
	InflightUntilMS    *int64
	MetricsOffset      int64
	CredentialRevision int64
	QuotaUsage         *int64
	StoreGone          bool
	StoreBusy          bool
	Breakers           Breakers
}

// Breakers is the shared incident ledger's answer for one scope.
type Breakers struct {
	WorkspaceOpen  bool
	DeploymentOpen bool
	EgressBlocked  bool
}

// SyncPurpose is which ledger a Seller call charges.
type SyncPurpose int

const (
	// PurposeReconcile is the scheduled walk: capped by the daily ledger.
	PurposeReconcile SyncPurpose = iota
	// PurposeManual is 「立即更新」: its own ledger, no daily cap.
	PurposeManual
)

// PurposeOf reads a job payload's purpose. Only the exact spelling is manual;
// a scheduled job that never set the field is the reconcile walk.
func PurposeOf(raw string) SyncPurpose {
	if raw == "manual" {
		return PurposeManual
	}
	return PurposeReconcile
}

// SyncUnit is the unit one wake executes.
type SyncUnit int

const (
	// UnitListLive is one live listing page.
	UnitListLive SyncUnit = iota
	// UnitListArchived is one archived listing page.
	UnitListArchived
	// UnitDetail is one info/list chunk over one undetailed page.
	UnitDetail
	// UnitFinalize is the whole-or-nothing commit.
	UnitFinalize
)

// Name is the unit's job-summary label.
func (u SyncUnit) Name() string {
	switch u {
	case UnitListLive, UnitListArchived:
		return "list"
	case UnitDetail:
		return "detail"
	default:
		return "finalize"
	}
}

// SyncDecision is what one wake does with its row. Exactly one field group is
// meaningful: Unit for a call, or the hold/void/skip answer.
type SyncDecision struct {
	// Call means spend one Seller call on Unit.
	Call bool
	Unit SyncUnit
	// Hold parks the row until UntilMS (nil only for an open-ended hold).
	Hold      string
	HoldUntil *int64
	// Reason is the stable hold_reason code.
	Reason string
	// Void clears the generation's progress and wakes at NextDueMS.
	Void      bool
	NextDueMS int64
	// Skip is a wake with nothing to spend and nothing to park.
	Skip bool
}

// DecideSync is the decision kernel. The check order is load-bearing: gone
// beats held beats expired beats breakers beats yield beats ledger — each
// earlier answer makes every later one moot.
func DecideSync(row SyncSnapshot, purpose SyncPurpose, nowMS int64) SyncDecision {
	// An unparseable pass reads as idle, the same fallback the row parse uses:
	// the constraint admits only the five spellings, and a missing value means
	// "no generation in flight", never "mid-walk".
	switch row.Pass {
	case PassListLive, PassListArchived, PassDetail, PassCommit:
	default:
		row.Pass = PassNone
	}
	switch row.Hold {
	case HoldNone, HoldYield, HoldBackoff, HoldBudget, HoldCooldown, HoldCredential, HoldDisabled:
	default:
		row.Hold = HoldNone
	}
	if row.StoreGone {
		return SyncDecision{Hold: HoldDisabled, Reason: ReasonStoreDisabled}
	}
	// A hold answers for itself while its window is open; an expired one is
	// history, and the row resumes from its own pass.
	if row.Hold != HoldNone && row.HoldUntilMS != nil && *row.HoldUntilMS > nowMS {
		return SyncDecision{Hold: row.Hold, HoldUntil: row.HoldUntilMS, Reason: leasedReason(row)}
	}
	// Progress that outlived three reconcile intervals is void, not resumed:
	// a generation pinned mid-pass for half a day describes a dead chain.
	if row.Pass != PassNone && row.GenerationStartMS != nil &&
		nowMS-*row.GenerationStartMS > GenerationMaxAgeMS {
		return SyncDecision{Void: true, NextDueMS: NextReconcileSlot(nowMS, row.StoreUUID)}
	}
	if row.Breakers.DeploymentOpen {
		until := nowMS + BreakerCooldownMS
		reason := ReasonDeploymentBreaker
		if row.Breakers.EgressBlocked {
			reason = ReasonEgressBlocked
		}
		return SyncDecision{Hold: HoldCooldown, HoldUntil: &until, Reason: reason}
	}
	if row.Breakers.WorkspaceOpen {
		until := nowMS + BreakerCooldownMS
		return SyncDecision{Hold: HoldCooldown, HoldUntil: &until, Reason: ReasonWorkspaceBreaker}
	}
	if row.StoreBusy {
		until := nowMS + YieldDeferMS
		return SyncDecision{Hold: HoldYield, HoldUntil: &until, Reason: ReasonStoreBusy}
	}
	// A press must always work when the row is clear: it rides its own ledger
	// and ignores the schedule.
	if purpose == PurposeManual {
		return SyncDecision{Call: true, Unit: plannedUnit(row.Pass)}
	}
	due := row.NextDueMS == nil || *row.NextDueMS <= nowMS
	if due || row.Pass != PassNone {
		if row.CallsSpent(PurposeReconcile, nowMS) >= ReconcileCap(row.cabinetTotal(), 0) {
			until := NextMoscowMidnight(nowMS)
			return SyncDecision{Hold: HoldBudget, HoldUntil: &until, Reason: ReasonBudgetExhausted}
		}
		return SyncDecision{Call: true, Unit: plannedUnit(row.Pass)}
	}
	return SyncDecision{Skip: true}
}

// CallsSpent is today's already-spent calls for one purpose. A ledger left
// over from another Moscow day reads as zero, which is the rollover.
func (r SyncSnapshot) CallsSpent(purpose SyncPurpose, nowMS int64) int {
	if r.CallsDay == nil || *r.CallsDay != MoscowDayKey(nowMS) {
		return 0
	}
	if purpose == PurposeManual {
		return r.CallsManual
	}
	return r.CallsReconcile
}

// cabinetTotal is the cabinet-size estimate the reconcile cap keys on: the
// Seller's assortment usage when known, the last committed count otherwise.
// Archived products still spend listing pages, so they are included.
func (r SyncSnapshot) cabinetTotal() int64 {
	if r.QuotaUsage != nil {
		return *r.QuotaUsage
	}
	if r.CountTotal != nil {
		total := *r.CountTotal
		if r.CountArchived != nil {
			total += *r.CountArchived
		}
		return total
	}
	return 0
}

// plannedUnit is the unit a generation's pass names. `none` opens the next
// walk at the live list: every generation is a full walk.
func plannedUnit(pass string) SyncUnit {
	switch pass {
	case PassListArchived:
		return UnitListArchived
	case PassDetail:
		return UnitDetail
	case PassCommit:
		return UnitFinalize
	default:
		return UnitListLive
	}
}

// leasedReason echoes a hold's own code. An unknown code reads as
// seller_error rather than inventing a reason the constraint would reject.
func leasedReason(row SyncSnapshot) string {
	if row.HoldReason == nil {
		return ReasonSellerError
	}
	switch *row.HoldReason {
	case ReasonRateLimited, ReasonGenerationExpired, ReasonCredentialRevoked,
		ReasonCredentialExpired, ReasonIPRestricted, ReasonWorkspaceBreaker,
		ReasonDeploymentBreaker, ReasonEgressBlocked, ReasonStoreBusy,
		ReasonBudgetExhausted, ReasonStoreDisabled, ReasonStagingLost:
		return *row.HoldReason
	}
	return ReasonSellerError
}

// FailureLanding is how one refusal parks the row.
type FailureLanding struct {
	// Hold is the hold kind the refusal earned.
	Hold string
	// UntilMS is when the hold lifts.
	UntilMS int64
	// Reason is the stable code.
	Reason string
	// Failure counts toward the streak. Credential verdicts never do: a dead
	// key is not the store's Seller reliability.
	Failure bool
	// Incident records a pressure signal when it is a pressure status.
	Incident bool
	// EgressShape records the egress-blocked signal whose distinct-store
	// aggregate decides the full stop.
	EgressShape bool
	// Pressure is the status that landed, for the incident row.
	Pressure int
}

// RefusalShape is what the Seller answer looked like, without the transport
// types: the kernel classifies shapes, the runner maps them.
type RefusalShape struct {
	// Status is the HTTP status; 0 means the request never completed.
	Status int
	// Message is Ozon's own error text when the body was a JSON error.
	Message string
	// JSONBody says the refusal carried a JSON error payload.
	JSONBody bool
	// Decoded says a 2xx body failed to decode.
	Decoded bool
	// RetryAfterMS is Ozon's own wait, already parsed.
	RetryAfterMS *int64
}

// OnSyncFailure classifies one refusal into the hold it earns. A credential
// verdict parks the store for a day and never counts as a failure streak;
// pressure refusals feed the ledger and pace the backoff; egress-shaped faults
// back this store off and record the shared-egress signal.
func OnSyncFailure(row SyncSnapshot, refusal RefusalShape, nowMS int64) FailureLanding {
	if reason := credentialVerdict(refusal); reason != "" {
		return FailureLanding{
			Hold: HoldCredential, UntilMS: nowMS + FailureCooldownMS, Reason: reason,
		}
	}
	failures := row.ConsecutiveFailure + 1
	wait := func() int64 {
		if refusal.RetryAfterMS != nil {
			if *refusal.RetryAfterMS < MaxRetryAfterMS {
				return *refusal.RetryAfterMS
			}
			return MaxRetryAfterMS
		}
		return BackoffMS(failures)
	}
	switch {
	case refusal.JSONBody:
		if IsPressureStatus(refusal.Status) {
			cooldown := failures >= ConsecutiveFailureLimit
			until := nowMS + wait()
			if cooldown {
				until = nowMS + FailureCooldownMS
			}
			return FailureLanding{
				Hold: holdFor(cooldown), UntilMS: until, Reason: ReasonRateLimited,
				Failure: true, Incident: true, Pressure: refusal.Status,
			}
		}
		return FailureLanding{
			Hold: HoldBackoff, UntilMS: nowMS + wait(), Reason: ReasonSellerError, Failure: true,
		}
	case refusal.Status != 0:
		// A pressure code in an off-dialect body is still Ozon refusing; a 403
		// HTML page is the egress, not the store.
		if IsPressureStatus(refusal.Status) {
			return FailureLanding{
				Hold: holdFor(failures >= ConsecutiveFailureLimit), UntilMS: nowMS + wait(),
				Reason: ReasonRateLimited, Failure: true, Incident: true, Pressure: refusal.Status,
			}
		}
		return FailureLanding{
			Hold: HoldBackoff, UntilMS: nowMS + wait(), Reason: ReasonEgressBlocked,
			Failure: true, EgressShape: true,
		}
	case refusal.Decoded:
		return FailureLanding{
			Hold: HoldBackoff, UntilMS: nowMS + wait(), Reason: ReasonEgressBlocked,
			Failure: true, EgressShape: true,
		}
	default:
		// The request never completed (refused connection, TLS).
		return FailureLanding{
			Hold: HoldBackoff, UntilMS: nowMS + wait(), Reason: ReasonEgressBlocked,
			Failure: true, EgressShape: true,
		}
	}
}

func holdFor(cooldown bool) string {
	if cooldown {
		return HoldCooldown
	}
	return HoldBackoff
}

// credentialVerdict reads Ozon's own word for a dead key. 401/403 are
// verdicts, not pressure; the IP-restriction sentence is its own code so the
// page can say exactly what to whitelist.
func credentialVerdict(refusal RefusalShape) string {
	if !refusal.JSONBody {
		return ""
	}
	if strings.Contains(refusal.Message, "restricted to specific IP") {
		return ReasonIPRestricted
	}
	if refusal.Status == 401 || refusal.Status == 403 {
		return ReasonCredentialRevoked
	}
	return ""
}

// ReconcileCap is the reconcile day's call ceiling:
// (2×ceil(live/1000) + ceil(archived/1000) + 1) × 6 generations × 1.5.
//
// Live pages pay twice (the page and the detail chunk of the same width), the
// +1 is the finalize unit's funnel page, the six are the 4 h cadence, and the
// half again covers probes and retries. An unknown cabinet still gets the
// probe cadence's allowance — a zero floor would budget-hold a fresh store
// before its first probe.
func ReconcileCap(live, archived int64) int {
	pages := func(items int64) int64 {
		if items < 0 {
			items = 0
		}
		return (items + 999) / 1000
	}
	perGeneration := pages(live)*2 + pages(archived) + 1
	cap := perGeneration * 6 * 3 / 2
	if cap < 9 {
		return 9
	}
	if cap > math.MaxInt32 {
		return math.MaxInt32
	}
	return int(cap)
}

// BackoffMS is exponential backoff for a failed unit: one minute doubling to
// a thirty minute cap.
func BackoffMS(consecutiveFailures int) int64 {
	shift := consecutiveFailures - 1
	if shift < 0 {
		shift = 0
	}
	if shift > 5 {
		shift = 5
	}
	wait := baseBackoffMS << uint(shift)
	if wait > maxBackoffMS {
		return maxBackoffMS
	}
	return wait
}

// IsPressureStatus reports Ozon's own backpressure. A 4xx about the request,
// a decode fault, or silence says nothing about how hard the fleet may push.
func IsPressureStatus(status int) bool { return status == 429 || status >= 500 }

// stableHash is FNV-1a over the store uuid. It must not change between
// releases: the reconcile slot phase derives from it, and a change would
// reshuffle every store's slot at once.
func stableHash(text string) uint64 {
	var hash uint64 = 0xcbf29ce484222325
	for i := 0; i < len(text); i++ {
		hash ^= uint64(text[i])
		hash *= 0x100000001b3
	}
	return hash
}

// NextReconcileSlot is the next moment this store's reconcile slot begins,
// strictly after nowMS. Slots spread the fleet evenly; one store, one slot.
func NextReconcileSlot(nowMS int64, storeUUID string) int64 {
	phase := int64(stableHash(storeUUID) % uint64(ReconcileIntervalMS))
	elapsed := nowMS - phase
	cycles := floorDiv(elapsed, ReconcileIntervalMS) + 1
	return phase + cycles*ReconcileIntervalMS
}

// floorDiv is div_euclid for a positive divisor: the quotient rounds toward
// negative infinity, so a clock before the phase still lands in the future.
func floorDiv(value, divisor int64) int64 {
	quotient := value / divisor
	if value%divisor != 0 && (value < 0) != (divisor < 0) {
		quotient--
	}
	return quotient
}

// MoscowDayKey is the daily ledger's rollover key: the Moscow date.
func MoscowDayKey(nowMS int64) string {
	at := time.UnixMilli(nowMS + moscowOffsetMS).UTC()
	return at.Format("2006-01-02")
}

// NextMoscowMidnight is when a spent purpose ledger reopens.
func NextMoscowMidnight(nowMS int64) int64 {
	shifted := nowMS + moscowOffsetMS
	dayStart := shifted - floorMod(shifted, msPerDay)
	return dayStart + msPerDay - moscowOffsetMS
}

// floorMod is rem_euclid for a positive divisor.
func floorMod(value, divisor int64) int64 {
	mod := value % divisor
	if mod < 0 {
		mod += divisor
	}
	return mod
}

// SlotCoveredByManual reports whether an automatic slot is already covered by
// a press that has since committed.
//
// A press stamps manual_requested_at_ms and sets next_due_at_ms to the same
// instant. That due row is the press, not a later slot: due_at == manual_at,
// and last_full_sync_at_ms is still the previous commit. Skipping it would
// drop the click. The skip is for the case it was written for: a generation
// committed at or after the press, an idle pass, and a *different* due
// instant falling inside the window.
func SlotCoveredByManual(pass string, dueAt int64, manualAt, lastFullSyncAtMS *int64, nowMS int64) bool {
	if manualAt == nil {
		return false
	}
	pressed := *manualAt
	return pass == PassNone &&
		dueAt != pressed &&
		lastFullSyncAtMS != nil && *lastFullSyncAtMS >= pressed &&
		nowMS-pressed < ManualAutoSkipMS
}

// SyncListRequest is one /v3/product/list page request.
type SyncListRequest struct {
	Visibility string `json:"visibility"`
	LastID     string `json:"last_id,omitempty"`
	Limit      int64  `json:"limit"`
}

// ListRequest builds one listing page request. An empty cursor is omitted:
// Ozon reads an empty string as a cursor, not as "first page".
func ListRequest(archived bool, lastID string) SyncListRequest {
	visibility := "ALL"
	if archived {
		visibility = "ARCHIVED"
	}
	return SyncListRequest{Visibility: visibility, LastID: lastID, Limit: ListPageLimit}
}

// SyncListPage is one /v3/product/list answer, already unwrapped from
// Ozon's `result` envelope.
type SyncListPage struct {
	LastID string
	Items  []SyncListItem
}

// SyncListItem is one listing row: the listing carries ids and nothing else.
type SyncListItem struct {
	ProductID int64  `json:"product_id"`
	OfferID   string `json:"offer_id"`
}

// ListPageDone decides whether a listing pass ends. It ends on an empty page,
// an empty cursor, an unchanged cursor (a retry that answered the same page),
// or a short page — Ozon's `total` is advisory, the items are the truth.
func ListPageDone(page SyncListPage, priorCursor string, count int64) bool {
	lastID := strings.TrimSpace(page.LastID)
	unchanged := priorCursor != "" && priorCursor == lastID
	return len(page.Items) == 0 || lastID == "" || unchanged || count < ListPageLimit
}

// SyncDetailRequest is one /v3/product/info/list chunk request.
type SyncDetailRequest struct {
	ProductID []string `json:"product_id"`
}

// DetailRequest builds the chunk request. Ozon takes the ids as strings.
func DetailRequest(productIDs []int64) SyncDetailRequest {
	out := SyncDetailRequest{ProductID: make([]string, 0, len(productIDs))}
	for _, id := range productIDs {
		out.ProductID = append(out.ProductID, strconv.FormatInt(id, 10))
	}
	return out
}

// SyncDetailPage is one info/list answer.
type SyncDetailPage struct {
	Items []SellerProduct
}

// AnswerIDSet is the set of product ids the detail read answered.
func (p SyncDetailPage) AnswerIDSet() map[int64]struct{} {
	out := make(map[int64]struct{}, len(p.Items))
	for _, item := range p.Items {
		out[item.ID] = struct{}{}
	}
	return out
}

// Unanswered is the chunk's ids the read said nothing about. They keep their
// dictionary state, but the page is still marked read: a deleted product must
// not pin the pending set forever.
func Unanswered(requested []int64, answered map[int64]struct{}) []int64 {
	out := make([]int64, 0, len(requested))
	for _, id := range requested {
		if _, ok := answered[id]; !ok {
			out = append(out, id)
		}
	}
	return out
}

// SyncMetricsRequest is one /v1/analytics/data page request.
type SyncMetricsRequest struct {
	DateFrom  string     `json:"date_from"`
	DateTo    string     `json:"date_to"`
	Dimension []string   `json:"dimension"`
	Limit     int64      `json:"limit"`
	Metrics   []string   `json:"metrics"`
	Offset    int64      `json:"offset"`
	Sort      []SyncSort `json:"sort"`
}

// SyncSort is one analytics sort key.
type SyncSort struct {
	Key   string `json:"key"`
	Order string `json:"order"`
}

// MetricsPeriodDays is the funnel window the UI labels 近 N 天.
const MetricsPeriodDays = int64(14)

// MetricsPageLimit is one analytics page.
const MetricsPageLimit = int64(1000)

// MetricsRequest builds one funnel page request. Ozon rate-limits this
// endpoint to roughly one call a minute, so the window rotates by offset.
func MetricsRequest(offset, nowMS int64) SyncMetricsRequest {
	through := time.UnixMilli(nowMS).UTC()
	return SyncMetricsRequest{
		DateFrom:  through.AddDate(0, 0, int(-(MetricsPeriodDays - 1))).Format("2006-01-02"),
		DateTo:    through.Format("2006-01-02"),
		Dimension: []string{"sku"},
		Limit:     MetricsPageLimit,
		Metrics: []string{
			"hits_view", "session_view", "hits_tocart",
			"conv_tocart", "ordered_units", "revenue",
		},
		Offset: offset,
		Sort:   []SyncSort{{Key: "sku", Order: "asc"}},
	}
}

// SyncFunnel is one analytics answer, already validated.
type SyncFunnel struct {
	Rows       []SkuFunnel
	NextOffset int64
	ThroughDay string
}

// SkuFunnel is one SKU's funnel over the window. `revenue` is rubles: the
// payload has no currency field, including for a CNY store.
type SkuFunnel struct {
	SKU          int64
	HitsView     float64
	SessionView  float64
	HitsTocart   float64
	ConvTocart   float64
	OrderedUnits float64
	Revenue      float64
}

// SyncMetricsOutcome is what the funnel call produced. A refusal is data, not
// a sync failure: it lands as `metrics_error` and never as a hold.
type SyncMetricsOutcome struct {
	// Fetched is non-nil when a validated page landed.
	Fetched *SyncFunnel
	// ErrorCode is the `metrics_error` vocabulary when the call was refused.
	ErrorCode string
	// Skipped means admission never produced a request: nothing was sent and
	// nothing is recorded; the charge goes back.
	Skipped bool
}

// MetricsErrorCodes is the `metrics_error` vocabulary the CHECK constraint
// allows.
var MetricsErrorCodes = []string{"rate_limited", "restricted", "refused", "invalid", "unavailable"}

// ProjectFunnel validates one analytics answer. A page that disagrees with
// itself (duplicate SKU, negative or non-finite metric) is a refusal, not data.
func ProjectFunnel(body []byte, offset int64, nowMS int64) (*SyncFunnel, string) {
	var root struct {
		Result *struct {
			Data []struct {
				Dimensions []struct {
					ID *string `json:"id"`
				} `json:"dimensions"`
				Metrics []float64 `json:"metrics"`
			} `json:"data"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, "invalid"
	}
	if root.Result == nil || root.Result.Data == nil {
		return nil, "invalid"
	}
	if int64(len(root.Result.Data)) > MetricsPageLimit {
		return nil, "invalid"
	}
	funnel := &SyncFunnel{
		Rows:       make([]SkuFunnel, 0, len(root.Result.Data)),
		ThroughDay: time.UnixMilli(nowMS).UTC().Format("2006-01-02"),
	}
	seen := make(map[int64]struct{}, len(root.Result.Data))
	for _, row := range root.Result.Data {
		if len(row.Dimensions) != 1 || row.Dimensions[0].ID == nil {
			return nil, "invalid"
		}
		raw := strings.TrimSpace(*row.Dimensions[0].ID)
		if raw == "" {
			return nil, "invalid"
		}
		sku, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || sku <= 0 {
			return nil, "invalid"
		}
		if len(row.Metrics) < 6 {
			return nil, "invalid"
		}
		for _, value := range row.Metrics[:6] {
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
				return nil, "invalid"
			}
		}
		if _, dup := seen[sku]; dup {
			return nil, "invalid"
		}
		seen[sku] = struct{}{}
		funnel.Rows = append(funnel.Rows, SkuFunnel{
			SKU: sku, HitsView: row.Metrics[0], SessionView: row.Metrics[1],
			HitsTocart: row.Metrics[2], ConvTocart: row.Metrics[3],
			OrderedUnits: row.Metrics[4], Revenue: row.Metrics[5],
		})
	}
	if int64(len(funnel.Rows)) == MetricsPageLimit {
		funnel.NextOffset = offset + MetricsPageLimit
	}
	return funnel, ""
}

// MetricsRefusalCode maps a refusal status onto the `metrics_error`
// vocabulary. The analytics endpoint may be Premium-restricted, so a 403 here
// must never look like a dead credential.
func MetricsRefusalCode(status int) string {
	switch {
	case status == 401 || status == 403:
		return "restricted"
	case status == 429:
		return "rate_limited"
	case status >= 400 && status < 500:
		return "refused"
	default:
		return "unavailable"
	}
}

// FxStampKind is what a metrics landing does to the fx columns.
type FxStampKind int

const (
	// FxKeep leaves a stamp another round recorded.
	FxKeep FxStampKind = iota
	// FxClear drops the conversion: the store prices in rubles.
	FxClear
	// FxSet records this round's quote.
	FxSet
)

// FxStamp is one metrics landing's conversion decision.
type FxStamp struct {
	Kind   FxStampKind
	Quote  string
	Rate   float64
	AsOf   string
	Source string
	// Replace is false for FxKeep: an absent value must not wipe a rate.
	Replace bool
}

// FxStampFor decides the conversion stamp from the store's contract currency.
// A missing quote is not a sync failure — the revenue stays labelled RUB.
func FxStampFor(currency *string, throughDay string, quote *FxStamp) FxStamp {
	if currency == nil {
		return FxStamp{Kind: FxKeep}
	}
	code := strings.ToUpper(strings.TrimSpace(*currency))
	if code == "" {
		return FxStamp{Kind: FxKeep}
	}
	if code == "RUB" {
		return FxStamp{Kind: FxClear, Replace: true}
	}
	if len(code) != 3 || !isASCIIAlpha(code) {
		return FxStamp{Kind: FxKeep}
	}
	if quote == nil || quote.Kind != FxSet {
		return FxStamp{Kind: FxKeep}
	}
	set := *quote
	set.AsOf = throughDay
	set.Replace = true
	return set
}

// SyncDayOf is the calendar day a window ends on, in UTC.
func SyncDayOf(nowMS int64) string {
	return time.UnixMilli(nowMS).UTC().Format("2006-01-02")
}

// IsJSONErrorBody reports whether a refusal carried Ozon's JSON error
// envelope. A WAF HTML page or an off-dialect body does not, and that
// difference decides whether the refusal blames the store or the egress.
func IsJSONErrorBody(body []byte) bool {
	trimmed := strings.TrimSpace(string(body))
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	var envelope struct {
		Message any `json:"message"`
		Code    any `json:"code"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return false
	}
	return envelope.Message != nil || envelope.Code != nil
}
