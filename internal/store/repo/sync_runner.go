// The store.product_sync runner. One claimed Job walks one store's generation
// unit by unit, and no Seller request ever runs inside a transaction.
//
// Each unit is:
//
//  1. Reserve (transaction 1) — locked read → gates → charge the day's
//     budget → write the inflight lease → commit. A crash after this point
//     keeps the charge: the budget may over-count, never under-count.
//  2. Call — through the egress, outside any transaction; the landing fence
//     discards stale results, never re-sends.
//  3. Land (transaction 2) — the three-condition fence (inflight token +
//     generation + cursor) gates the write; a miss discards the whole unit as
//     stale_inflight.
//
// A Seller refusal is sync state, not a job failure: it lands on the row
// (incident, backoff or cooldown) and the Job still settles succeeded. The Job
// only fails on genuine internal errors, which retry through max_attempts.
package storerepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/jobsched"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// KindProductSync is the queue kind this file's runner executes.
const KindProductSync = "store.product_sync"

// reasonRateLimited is the queue's requeue reason for an admission refusal.
const reasonRateLimited = "rate_limited"

// staleLimit bounds how many landings may go stale before this Job concedes to
// the row's current owner.
const staleLimit = 5

// generationParkMS is how far a deliberately disabled store's hold window
// reaches. The hold axis requires a window on every non-'none' hold; a
// disabled store is out of the scheduler's set anyway, so the number only
// has to be plainly in the future.
const generationParkMS = int64(10 * 365 * 24 * 60 * 60 * 1000)

// RunProductSync runs one claimed store.product_sync Job. It settles the jobs row itself;
// a nil return means the loop must not settle again.
func RunProductSync(ctx context.Context, pool *pgxpool.Pool, job jobsched.Claimed, egress SellerEgress, ring seal.Ring, keyID string, admission func(error) bool) error {
	var payload struct {
		StoreID string `json:"storeId"`
		Purpose string `json:"purpose"`
	}
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("store.product_sync payload: %w", err)
	}
	if strings.TrimSpace(payload.StoreID) == "" {
		return errors.New("store.product_sync payload has no storeId")
	}
	run := syncRunner{
		pool: pool, job: job, egress: egress, ring: ring, keyID: keyID,
		admission: admission,
		orgID:     job.OrgID, storeUUID: payload.StoreID,
		purpose: domain.PurposeOf(payload.Purpose),
	}
	return run.loop(ctx)
}

// runner is one Job's in-process walk. The row is the truth; this struct only
// carries what the loop needs to keep going.
type syncRunner struct {
	pool      *pgxpool.Pool
	job       jobsched.Claimed
	egress    SellerEgress
	ring      seal.Ring
	keyID     string
	orgID     int64
	storeUUID string
	purpose   domain.SyncPurpose
	// admission classifies an egress error as "our own gate refused" rather
	// than "the Seller never answered". The assembly layer supplies it.
	admission func(error) bool
}

// loop is run_with: reserve, call, land until a resting state, the time budget,
// or the stale limit. The Job settles once at the end unless a reserve settled
// it inside its own transaction.
func (r syncRunner) loop(ctx context.Context) error {
	deadline := time.Now().Add(time.Duration(domain.JobTimeBudgetMS) * time.Millisecond)
	landed, calls, stale := 0, 0, 0
	lastUnit := "none"
	var resting any
	for {
		if landed+stale > 0 {
			// A lost lease means the Job was reclaimed: stop without settling.
			// Its successor continues from the cursor.
			ok, err := r.heartbeat(ctx)
			if err != nil || !ok {
				return nil
			}
		}
		outcome, err := r.reserve(ctx)
		if err != nil {
			return err
		}
		switch outcome.kind {
		case reserveSettled:
			// The reserve committed the Job's terminal state itself.
			return nil
		case reserveRequeue:
			return r.requeue(ctx, string(reasonRateLimited), outcome.wait)
		}
		handOff := !time.Now().Before(deadline)
		unitName := outcome.unit.Name()
		verdict, err := r.execute(ctx, outcome, handOff)
		if err != nil {
			return err
		}
		if verdict == stepRequeue {
			return r.requeue(ctx, string(reasonRateLimited), outcome.wait)
		}
		calls++
		lastUnit = unitName
		switch verdict {
		case stepStale:
			// The call left and its charge stands — only its results were
			// discarded.
			stale++
			if stale < staleLimit {
				continue
			}
			resting = map[string]any{"stale_inflight": stale}
		case stepContinue:
			landed++
			continue
		case stepHandOff:
			landed++
			resting = map[string]any{"handed_off": true}
		default:
			landed++
		}
		break
	}
	summary, _ := json.Marshal(map[string]any{
		"units": landed, "calls": calls, "stale_inflight": stale,
		"last_unit": lastUnit, "resting": resting,
	})
	if jobsched.Finish == nil {
		return errors.New("queue kernel is not linked")
	}
	_, err := jobsched.Finish(ctx, r.pool, r.job.Lease(), jobsched.StateSucceeded, summary, "")
	return err
}

type reserveKind int

const (
	reserveSettled reserveKind = iota
	reserveRequeue
	reserveUnit
)

type reserveOutcome struct {
	kind  reserveKind
	wait  time.Duration
	state domain.SyncSnapshot
	unit  domain.SyncUnit
	token string
	// pageNo and productIDs are the detail unit's chunk; the list units read
	// their cursor from state.
	pageNo     int32
	productIDs []int64
	// credential is the plaintext pair the call spends.
	credential domain.OpenedCredential
	// landed mirrors the landing verdict's outcome for the loop's counters.
	landed bool
}

type step int

const (
	stepContinue step = iota
	stepHandOff
	stepRest
	stepStale
	stepRequeue
)

// reserve is phase one: decide and reserve one unit, charging the budget and
// writing the inflight lease. Every refusal settles the Job after landing its
// own state write.
func (r syncRunner) reserve(ctx context.Context) (reserveOutcome, error) {
	nowMS := domain.NowMS()
	var out reserveOutcome
	err := r.withWorkerTx(ctx, func(tx pgx.Tx) error {
		state, err := LoadSyncSnapshotTx(ctx, tx, r.orgID, r.storeUUID, nowMS, true)
		if errors.Is(err, pgx.ErrNoRows) {
			// The store was deleted or never got a sync row.
			out.kind = reserveSettled
			return r.settleInTx(ctx, tx, map[string]any{"skipped": "no_sync_row"})
		}
		if err != nil {
			return err
		}
		// Another worker holds this store's inflight lease — its loop owns the
		// progress. Come back when the lease (or its watchdog) expires.
		if state.InflightUntilMS != nil && *state.InflightUntilMS > nowMS {
			out.kind = reserveRequeue
			out.wait = time.Duration(*state.InflightUntilMS-nowMS)*time.Millisecond + time.Second
			return nil
		}
		decision := domain.DecideSync(*state, r.purpose, nowMS)
		switch {
		case decision.Void:
			if err := VoidSyncGenerationTx(ctx, tx, *state, decision.NextDueMS); err != nil {
				return err
			}
			out.kind = reserveSettled
			return r.settleInTx(ctx, tx, map[string]any{"skipped": "generation_expired"})
		case decision.Skip:
			out.kind = reserveSettled
			return r.settleInTx(ctx, tx, map[string]any{"skipped": "not_due"})
		case decision.Hold != "":
			// `hold_shape` admits no open-ended hold: a non-'none' hold must
			// carry a window, so a gone or disabled store lands 'disabled' with
			// a far-future one rather than a bare NULL. The store is never
			// woken again in either case — it is out of the scheduler's set.
			until := decision.HoldUntil
			if until == nil {
				far := nowMS + generationParkMS
				until = &far
			}
			if err := LandSyncHoldTx(ctx, tx, *state, decision.Hold, until, decision.Reason); err != nil {
				return err
			}
			out.kind = reserveSettled
			return r.settleInTx(ctx, tx, map[string]any{"skipped": decision.Reason})
		}
		// The detail pass derives its chunk live: an empty pending set means
		// the generation is ready to commit.
		unit := decision.Unit
		var pageNo int32
		var productIDs []int64
		if unit == domain.UnitDetail {
			found, ids, ok, err := PendingDetailPageTx(ctx, tx, *state)
			if err != nil {
				return err
			}
			if !ok {
				unit = domain.UnitFinalize
			} else {
				pageNo, productIDs = found, ids
			}
		}
		// The credential opens inside the lock so an expired key never sends.
		credential, err := OpenCredentialTx(ctx, tx, r.ring, r.keyID, *state, nowMS)
		if err != nil {
			// A missing or expired key is not a Seller failure: no incident and
			// no failure streak. The credential hold rechecks once a day.
			reason := domain.ReasonCredentialRevoked
			if errors.Is(err, ErrCredentialExpired) {
				reason = domain.ReasonCredentialExpired
			}
			until := nowMS + domain.FailureCooldownMS
			if err := LandSyncHoldTx(ctx, tx, *state, domain.HoldCredential, &until, reason); err != nil {
				return err
			}
			out.kind = reserveSettled
			return r.settleInTx(ctx, tx, map[string]any{"skipped": reason})
		}
		token := uuid.NewString()
		if err := SpendSyncCallTx(ctx, tx, r.orgID, r.storeUUID, r.purpose,
			domain.MoscowDayKey(nowMS)); err != nil {
			return err
		}
		if err := ClaimSyncLeaseTx(ctx, tx, r.storeUUID, r.orgID, token,
			nowMS+domain.ChainWatchdogMS); err != nil {
			return err
		}
		out = reserveOutcome{
			kind: reserveUnit, state: *state, unit: unit, token: token,
			pageNo: pageNo, productIDs: productIDs, credential: credential,
		}
		return nil
	})
	return out, err
}

// execute is phases two and three: the call outside any transaction, then the
// landing transaction behind the fence.
func (r syncRunner) execute(ctx context.Context, reserved reserveOutcome, handOff bool) (step, error) {
	nowMS := domain.NowMS()
	var response any
	var fault *callFault
	switch reserved.unit {
	case domain.UnitListLive, domain.UnitListArchived:
		archived := reserved.unit == domain.UnitListArchived
		lastID := ""
		if reserved.state.CursorLastID != nil {
			lastID = *reserved.state.CursorLastID
		}
		body, err := json.Marshal(domain.ListRequest(archived, lastID))
		if err != nil {
			return stepRest, err
		}
		status, raw, callErr := r.call(ctx, reserved.credential, "/v3/product/list", body)
		if callErr != nil {
			fault = callErr
			break
		}
		page, shape := decodeListPage(status, raw)
		if shape != nil {
			fault = shape
			break
		}
		response = page
	case domain.UnitDetail:
		body, err := json.Marshal(domain.DetailRequest(reserved.productIDs))
		if err != nil {
			return stepRest, err
		}
		status, raw, callErr := r.call(ctx, reserved.credential, "/v3/product/info/list", body)
		if callErr != nil {
			fault = callErr
			break
		}
		page, shape := decodeDetailPage(status, raw)
		if shape != nil {
			fault = shape
			break
		}
		response = page
	case domain.UnitFinalize:
		body, err := json.Marshal(domain.MetricsRequest(reserved.state.MetricsOffset, nowMS))
		if err != nil {
			return stepRest, err
		}
		status, raw, callErr := r.call(ctx, reserved.credential, "/v1/analytics/data", body)
		response = r.metricsOutcome(reserved, status, raw, callErr, nowMS)
	}
	if fault != nil {
		if fault.admission {
			// Our own infrastructure refused: nothing was sent and the charge
			// goes back. The row is untouched.
			if err := r.release(ctx, reserved); err != nil {
				return stepRest, err
			}
			return stepRequeue, nil
		}
		return stepRest, r.landFailure(ctx, reserved, *fault, nowMS)
	}
	verdict, err := r.land(ctx, reserved, response, nowMS, handOff)
	if err != nil {
		return stepRest, err
	}
	switch verdict {
	case stepStale:
		return stepStale, nil
	case stepHandOff:
		return stepHandOff, nil
	case stepRest:
		return stepRest, nil
	default:
		return stepContinue, nil
	}
}

// metricsOutcome folds the funnel answer. Its refusals are data, not faults:
// they land as metrics_error, with no hold, no incident and no streak.
func (r syncRunner) metricsOutcome(reserved reserveOutcome, status int, raw []byte, callErr *callFault, nowMS int64) domain.SyncMetricsOutcome {
	if callErr != nil {
		if callErr.admission {
			return domain.SyncMetricsOutcome{Skipped: true}
		}
		return domain.SyncMetricsOutcome{ErrorCode: "unavailable"}
	}
	if status < 200 || status >= 300 {
		return domain.SyncMetricsOutcome{ErrorCode: domain.MetricsRefusalCode(status)}
	}
	page, code := domain.ProjectFunnel(raw, reserved.state.MetricsOffset, nowMS)
	if code != "" {
		return domain.SyncMetricsOutcome{ErrorCode: code}
	}
	return domain.SyncMetricsOutcome{Fetched: page}
}

// land is phase three. A stale fence rolls the whole landing back; every other
// verdict commits it.
func (r syncRunner) land(ctx context.Context, reserved reserveOutcome, response any, nowMS int64, handOff bool) (step, error) {
	verdict := stepContinue
	err := r.withWorkerTx(ctx, func(tx pgx.Tx) error {
		switch reserved.unit {
		case domain.UnitListLive, domain.UnitListArchived:
			page, ok := response.(domain.SyncListPage)
			if !ok {
				return errors.New("list unit landed no page")
			}
			archived := reserved.unit == domain.UnitListArchived
			landed, err := r.landList(ctx, tx, reserved, page, archived, nowMS, handOff)
			verdict = landed
			return err
		case domain.UnitDetail:
			page, ok := response.(domain.SyncDetailPage)
			if !ok {
				return errors.New("detail unit landed no page")
			}
			landed, err := r.landDetail(ctx, tx, reserved, page, nowMS, handOff)
			verdict = landed
			return err
		case domain.UnitFinalize:
			outcome, ok := response.(domain.SyncMetricsOutcome)
			if !ok {
				return errors.New("finalize unit landed no outcome")
			}
			landed, err := r.landFinalize(ctx, tx, reserved, outcome, nowMS)
			verdict = landed
			return err
		}
		return nil
	})
	if err != nil {
		return stepRest, err
	}
	return verdict, nil
}

// landList mirrors one page, advances the pass, and queues the continuation
// when the time budget is spent.
func (r syncRunner) landList(ctx context.Context, tx pgx.Tx, reserved reserveOutcome, page domain.SyncListPage, archived bool, nowMS int64, handOff bool) (step, error) {
	state := reserved.state
	productIDs := make([]int64, 0, len(page.Items))
	offerIDs := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		productIDs = append(productIDs, item.ProductID)
		offerIDs = append(offerIDs, item.OfferID)
	}
	if err := StageSyncListingTx(ctx, tx, state, archived, productIDs, offerIDs); err != nil {
		return stepRest, err
	}
	count := int64(len(page.Items))
	prior := ""
	if state.CursorLastID != nil {
		prior = *state.CursorLastID
	}
	lastID := strings.TrimSpace(page.LastID)
	done := domain.ListPageDone(page, prior, count)
	var pass string
	var cursor *string
	switch {
	case !done:
		pass = domain.PassListLive
		if archived {
			pass = domain.PassListArchived
		}
		cursor = &lastID
	case !archived:
		pass = domain.PassListArchived
	default:
		pass = domain.PassDetail
	}
	// Page numbers run continuously across both passes: the key is
	// (store_pk, generation, page_no) and the archived flag is data. An empty
	// page stages nothing.
	pageNo := int32(-1)
	if count > 0 {
		if total := state.PassPagesLive + state.PassPagesArchived; total < 1<<31-1 {
			pageNo = int32(total)
		}
	}
	won, err := LandSyncPassTx(ctx, tx, state, reserved.token, pass, cursor, pageNo, archived, productIDs, nowMS)
	if err != nil {
		return stepRest, err
	}
	if !won {
		return stepStale, nil
	}
	if handOff {
		if err := r.enqueueContinuationTx(ctx, tx, state, continuationKey(pass, cursor)); err != nil {
			return stepRest, err
		}
		return stepHandOff, nil
	}
	return stepContinue, nil
}

// landDetail writes one chunk, marks the page read, and continues.
func (r syncRunner) landDetail(ctx context.Context, tx pgx.Tx, reserved reserveOutcome, page domain.SyncDetailPage, nowMS int64, handOff bool) (step, error) {
	state := reserved.state
	unanswered := domain.Unanswered(reserved.productIDs, page.AnswerIDSet())
	won, err := LandSyncDetailTx(ctx, tx, state, reserved.token, reserved.pageNo, page.Items, unanswered, nowMS)
	if err != nil {
		return stepRest, err
	}
	if !won {
		return stepStale, nil
	}
	if handOff {
		key := fmt.Sprintf("detail:%d", reserved.pageNo)
		if err := r.enqueueContinuationTx(ctx, tx, state, key); err != nil {
			return stepRest, err
		}
		return stepHandOff, nil
	}
	return stepContinue, nil
}

// landFinalize is the whole-or-nothing commit. The staging guard comes first:
// the persisted page counters must match the staging table's rows, or the
// generation is void — a crashed process empties the UNLOGGED table, and
// guessing "gone" over missing pages would delete products that are simply
// unlisted this round.
func (r syncRunner) landFinalize(ctx context.Context, tx pgx.Tx, reserved reserveOutcome, outcome domain.SyncMetricsOutcome, nowMS int64) (step, error) {
	state := reserved.state
	live, archived, err := StagingCountsTx(ctx, tx, state)
	if err != nil {
		return stepRest, err
	}
	if int64(state.PassPagesLive) != live || int64(state.PassPagesArchived) != archived {
		if err := voidStagingLostTx(ctx, tx, state, reserved.token,
			domain.NextReconcileSlot(nowMS, state.StoreUUID)); err != nil {
			return stepRest, err
		}
		// The funnel call may have been refused or never sent; either way it
		// proved nothing about this generation, so its charge goes back.
		if refundableMetrics(outcome) {
			if err := RefundSyncCallTx(ctx, tx, state.OrgID, state.StoreUUID,
				r.purpose, domain.MoscowDayKey(nowMS)); err != nil {
				return stepRest, err
			}
		}
		return stepRest, nil
	}
	if err := MarkGoneSyncProductsTx(ctx, tx, state, nowMS); err != nil {
		return stepRest, err
	}
	won, err := CommitSyncGenerationTx(ctx, tx, state, reserved.token, nowMS,
		domain.NextReconcileSlot(nowMS, state.StoreUUID))
	if err != nil {
		return stepRest, err
	}
	if !won {
		return stepStale, nil
	}
	stamp, err := r.fxStamp(ctx, tx, state, outcome, nowMS)
	if err != nil {
		return stepRest, err
	}
	if err := LandSyncMetricsTx(ctx, tx, state, outcome, stamp, nowMS); err != nil {
		return stepRest, err
	}
	if err := DropStagingPagesTx(ctx, tx, state); err != nil {
		return stepRest, err
	}
	// A refused or never-sent funnel page kept its reservation but not its
	// cost: the generation committed on the listing facts, not on analytics.
	if refundableMetrics(outcome) {
		if err := RefundSyncCallTx(ctx, tx, state.OrgID, state.StoreUUID,
			r.purpose, domain.MoscowDayKey(nowMS)); err != nil {
			return stepRest, err
		}
	}
	return stepRest, nil
}

// refundableMetrics reports a funnel call that provably did not reach Ozon: a
// refusal or an admission that produced no request. A landed page keeps its
// charge, and so does an unknown outcome.
func refundableMetrics(outcome domain.SyncMetricsOutcome) bool {
	return outcome.Skipped || (outcome.Fetched == nil && outcome.ErrorCode != "")
}

// fxStamp resolves the conversion for the funnel revenue. A database or a
// missing quote is "keep": the page still lands, labelled RUB.
func (r syncRunner) fxStamp(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, outcome domain.SyncMetricsOutcome, _ int64) (domain.FxStamp, error) {
	if outcome.Fetched == nil {
		return domain.FxStamp{Kind: domain.FxKeep}, nil
	}
	currency, err := StoreCurrencyTx(ctx, tx, state)
	if err != nil {
		return domain.FxStamp{Kind: domain.FxKeep}, nil
	}
	// The Bank of Russia quote is an outbound fetch; it is not bound in this
	// build, so a non-RUB store keeps the ruble label rather than inventing a
	// rate. RUB stores still get their stale stamps cleared.
	return domain.FxStampFor(currency, outcome.Fetched.ThroughDay, nil), nil
}

// landFailure records a refusal and refunds the charge, behind the same fence.
func (r syncRunner) landFailure(ctx context.Context, reserved reserveOutcome, fault callFault, nowMS int64) error {
	landing := domain.OnSyncFailure(reserved.state, fault.shape(), nowMS)
	return r.withWorkerTx(ctx, func(tx pgx.Tx) error {
		if landing.Incident || landing.EgressShape {
			origin := "product_sync"
			status := landing.Pressure
			if landing.EgressShape {
				origin = "egress_blocked"
				status = 0
			}
			if err := RecordSyncIncidentTx(ctx, tx, reserved.state, reserved.credential.ClientID,
				fault.path, origin, status, nowMS); err != nil {
				return err
			}
		}
		if err := RecordSyncFailureTx(ctx, tx, reserved.state, reserved.token, landing, nowMS); err != nil {
			return err
		}
		return RefundSyncCallTx(ctx, tx, reserved.state.OrgID, reserved.state.StoreUUID,
			r.purpose, domain.MoscowDayKey(nowMS))
	})
}

// release gives a reservation back when the call provably never happened:
// clear the lease and refund the charge.
func (r syncRunner) release(ctx context.Context, reserved reserveOutcome) error {
	return r.withWorkerTx(ctx, func(tx pgx.Tx) error {
		if _, err := ClearSyncLeaseTx(ctx, tx, reserved.state, reserved.token); err != nil {
			return err
		}
		return RefundSyncCallTx(ctx, tx, reserved.state.OrgID, reserved.state.StoreUUID,
			r.purpose, domain.MoscowDayKey(domain.NowMS()))
	})
}

// enqueueContinuationTx queues the next unit of this chain inside the landing's
// own transaction: "the unit landed" and "its successor exists" are one fact.
func (r syncRunner) enqueueContinuationTx(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, key string) error {
	if jobsched.EnqueueOn == nil {
		return errors.New("queue kernel is not linked")
	}
	payload := map[string]any{"storeId": state.StoreUUID}
	if r.purpose == domain.PurposeManual {
		payload["purpose"] = "manual"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = jobsched.EnqueueOn(ctx, tx, []jobsched.NewJob{{
		ID:              uuid.New(),
		OrgID:           state.OrgID,
		Kind:            KindProductSync,
		AggregateType:   "store_product_sync",
		AggregateID:     uuid.MustParse(state.StoreUUID),
		InputRevision:   1,
		IdempotencyKey:  fmt.Sprintf("product-sync:%s:%d:%s", state.StoreUUID, state.RefreshGeneration, key),
		Payload:         body,
		SubmitterUserID: state.SubmitterUserID,
		MaxAttempts:     3,
		Priority:        90,
	}}, 0)
	return err
}

// continuationKey names the successor unit — pass plus cursor tail — so the
// reclaimed Job recomputes the same unit, not just a wake.
func continuationKey(pass string, cursor *string) string {
	if cursor != nil && *cursor != "" {
		return pass + ":" + *cursor
	}
	return pass
}

// heartbeat extends the Job lease. A lost lease means the Job was reclaimed.
func (r syncRunner) heartbeat(ctx context.Context) (bool, error) {
	if jobsched.Renew == nil {
		return false, errors.New("queue kernel is not linked")
	}
	return jobsched.Renew(ctx, r.pool, r.job.Lease())
}

// requeue hands the Job back for the wait an admission refusal named.
func (r syncRunner) requeue(ctx context.Context, reason string, wait time.Duration) error {
	if jobsched.Requeue == nil {
		return errors.New("queue kernel is not linked")
	}
	_, err := jobsched.Requeue(ctx, r.pool, r.job.Lease(), reason, wait)
	return err
}

// settleInTx settles the Job inside the reserve's own transaction.
func (r syncRunner) settleInTx(ctx context.Context, tx pgx.Tx, summary map[string]any) error {
	body, err := json.Marshal(summary)
	if err != nil {
		return err
	}
	return SettleJobTx(ctx, tx, r.job.Lease(), jobsched.StateSucceeded, body)
}

// withWorkerTx opens one cross-tenant worker transaction. Every statement the
// runner issues names its own org, so the worker role is enough; the tenant GUC
// stays unset exactly as the scheduler's own scans leave it.
func (r syncRunner) withWorkerTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// call is one Seller read. A Go error here is not a Seller refusal: it is
// either our own admission (the request never left) or a transport fault the
// kernel classifies. The distinction decides whether the store is parked.
func (r syncRunner) call(ctx context.Context, credential domain.OpenedCredential, path string, body []byte) (int, []byte, *callFault) {
	if r.egress == nil {
		return 0, nil, &callFault{admission: true, path: path}
	}
	status, raw, err := r.egress.SellerRead(ctx, path, body, credential.ClientID, credential.APIKey)
	if err != nil {
		fault := &callFault{transport: true, path: path, err: err}
		if r.admission != nil && r.admission(err) {
			fault = &callFault{admission: true, path: path, err: err}
		}
		return 0, nil, fault
	}
	return status, raw, nil
}

// callFault is a call that produced no landing.
type callFault struct {
	// admission means our own infrastructure refused before a request left.
	admission bool
	// transport means the request never completed.
	transport bool
	// decode means a 2xx body did not parse.
	decode bool
	status int
	body   []byte
	path   string
	err    error
}

// shape maps the fault onto the kernel's vocabulary.
func (f callFault) shape() domain.RefusalShape {
	if f.decode {
		return domain.RefusalShape{Decoded: true}
	}
	if f.transport {
		return domain.RefusalShape{}
	}
	return domain.RefusalShape{
		Status: f.status, Message: domain.OzonReason(f.body),
		JSONBody: domain.IsJSONErrorBody(f.body),
	}
}

// decodeListPage reads one /v3/product/list answer.
func decodeListPage(status int, raw []byte) (domain.SyncListPage, *callFault) {
	if status < 200 || status >= 300 {
		return domain.SyncListPage{}, &callFault{status: status, body: raw}
	}
	var envelope struct {
		Result *domain.SyncListPage `json:"result"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Result == nil {
		return domain.SyncListPage{}, &callFault{decode: true, status: status, body: raw}
	}
	return *envelope.Result, nil
}

// decodeDetailPage reads one /v3/product/info/list answer.
func decodeDetailPage(status int, raw []byte) (domain.SyncDetailPage, *callFault) {
	if status < 200 || status >= 300 {
		return domain.SyncDetailPage{}, &callFault{status: status, body: raw}
	}
	var page domain.SyncDetailPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return domain.SyncDetailPage{}, &callFault{decode: true, status: status, body: raw}
	}
	return page, nil
}

// SweepDueProductSync is the reconcile tick's half: materialize rows for stores that never
// had one, then wake the due ones. It returns how many jobs were newly
// enqueued; a dedup re-run is free.
func SweepDueProductSync(ctx context.Context, pool *pgxpool.Pool, limit int, disabled bool) (int, error) {
	if disabled || limit <= 0 {
		return 0, nil
	}
	if limit > 256 {
		limit = 256
	}
	nowMS := domain.NowMS()
	enqueued := 0
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return 0, err
	}
	if err := MaterializeSyncRowsTx(ctx, tx, nowMS); err != nil {
		return 0, err
	}
	due, err := DueSyncRowsTx(ctx, tx, nowMS, limit)
	if err != nil {
		return 0, err
	}
	jobs := make([]jobsched.NewJob, 0, len(due))
	for _, row := range due {
		// A manual generation that already committed inside the window covers
		// the automatic slot that lands there. The press itself is enqueued:
		// that is 「立即更新」.
		if row.ManualRequestedAtMS != nil && domain.SlotCoveredByManual(
			deref(row.Pass, "none"), derefInt(row.NextDueMS), row.ManualRequestedAtMS,
			row.LastFullSyncAtMS, nowMS) {
			next := domain.NextReconcileSlot(*row.ManualRequestedAtMS+domain.ManualAutoSkipMS, row.StoreUUID)
			if err := SetSyncNextDueTx(ctx, tx, row.OrgID, row.StoreUUID, next); err != nil {
				return 0, err
			}
			continue
		}
		purpose := ""
		key := fmt.Sprintf("product-sync:%s:%d", row.StoreUUID, derefInt(row.NextDueMS))
		if row.ManualRequestedAtMS != nil && row.NextDueMS != nil && *row.ManualRequestedAtMS == *row.NextDueMS {
			purpose = "manual"
			key = fmt.Sprintf("product-sync:%s:manual:%d", row.StoreUUID, *row.NextDueMS)
		}
		payload := map[string]any{"storeId": row.StoreUUID}
		if purpose != "" {
			payload["purpose"] = purpose
		}
		body, err := json.Marshal(payload)
		if err != nil {
			return 0, err
		}
		jobs = append(jobs, jobsched.NewJob{
			ID:              uuid.New(),
			OrgID:           row.OrgID,
			Kind:            KindProductSync,
			AggregateType:   "store_product_sync",
			AggregateID:     uuid.MustParse(row.StoreUUID),
			InputRevision:   1,
			IdempotencyKey:  key,
			Payload:         body,
			SubmitterUserID: row.SubmitterUserID,
			MaxAttempts:     3,
			Priority:        90,
		})
	}
	if len(jobs) > 0 {
		if jobsched.EnqueueOn == nil {
			return 0, errors.New("queue kernel is not linked")
		}
		queued, err := jobsched.EnqueueOn(ctx, tx, jobs, 0)
		if err != nil {
			return 0, err
		}
		for _, row := range queued {
			if row.Inserted {
				enqueued++
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	if enqueued > 0 {
		slog.Info("product sync sweep", "enqueued", enqueued)
	}
	return enqueued, nil
}

func deref(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func derefInt(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

// CleanupProductSync is the daily old-data sweep: gone products past their retention,
// mirrors of stores soft-deleted past theirs, and pressure incidents past
// seven days. Every statement is one set-based DELETE, safe to re-run.
func CleanupProductSync(ctx context.Context, pool *pgxpool.Pool) error {
	nowMS := domain.NowMS()
	_, err := pool.Exec(ctx, `SELECT 1`)
	if err != nil {
		return err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return err
	}
	if err := CleanupSyncRowsTx(ctx, tx, nowMS); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
