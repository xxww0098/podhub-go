package storerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The runner's phase-one read and its two ledgers. Every Seller-spending path
// asks the same gate; the sync runner is the only one that takes the row
// `FOR UPDATE`, because it is the only one that will write the lease.

// LoadSyncSnapshot reads one row's whole decision input: the sync row, the
// store facts, the store-busy predicate, and the breakers. It runs on a
// worker transaction, because a scheduled wake has no user and no tenant GUC
// until the row names its org.
func loadSyncSnapshot(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, nowMS int64, locked bool) (*domain.SyncSnapshot, error) {
	query := `
		SELECT p.store_id::text, s.id, p.org_id, o.owner_user_id,
		       p.refresh_generation, p.pass, p.hold, p.hold_until_ms, p.hold_reason,
		       p.cursor_last_id, p.count_total, p.count_archived,
		       p.consecutive_failures, p.generation_started_at_ms,
		       p.calls_day::text, p.calls_reconcile, p.calls_manual,
		       p.pass_pages_live, p.pass_pages_archived, p.next_due_at_ms,
		       p.inflight_until_ms, p.metrics_offset,
		       s.credential_revision,
		       (s.deleted_at_ms IS NOT NULL OR s.manual_disabled OR NOT public.subscription_store_allowed(s.org_id,s.uuid,clock_timestamp())),
		       EXISTS (SELECT 1 FROM public.submission_intents i
		                WHERE i.org_id = p.org_id AND i.store_id = p.store_id
		                  AND i.state IN ('queued','submitting'))
		         OR EXISTS (SELECT 1 FROM public.store_seller_credentials c
		                     WHERE c.store_id = s.id AND c.last_leased_at_ms > $3),
		       (s.product_quota #>> '{total,usage}')
		  FROM public.store_product_sync p
		  JOIN public.organization_stores s ON s.uuid = p.store_id AND s.org_id = p.org_id
		  JOIN public.organizations o ON o.id = p.org_id
		 WHERE p.store_id = $1::uuid AND p.org_id = $2`
	if locked {
		query += " FOR UPDATE OF p"
	}
	var out domain.SyncSnapshot
	var quotaUsage *string
	err := tx.QueryRow(ctx, query, storeUUID, orgID, nowMS-domain.YieldDeferMS).Scan(
		&out.StoreUUID, &out.StorePK, &out.OrgID, &out.SubmitterUserID,
		&out.RefreshGeneration, &out.Pass, &out.Hold, &out.HoldUntilMS, &out.HoldReason,
		&out.CursorLastID, &out.CountTotal, &out.CountArchived,
		&out.ConsecutiveFailure, &out.GenerationStartMS,
		&out.CallsDay, &out.CallsReconcile, &out.CallsManual,
		&out.PassPagesLive, &out.PassPagesArchived, &out.NextDueMS,
		&out.InflightUntilMS, &out.MetricsOffset,
		&out.CredentialRevision, &out.StoreGone, &out.StoreBusy,
		&quotaUsage,
	)
	if err != nil {
		return nil, err
	}
	if quotaUsage != nil {
		if parsed, ok := parseInt64(*quotaUsage); ok {
			out.QuotaUsage = &parsed
		}
	}
	breakers, err := readBreakers(ctx, tx, orgID, nowMS)
	if err != nil {
		return nil, err
	}
	out.Breakers = domain.Breakers{
		WorkspaceOpen:  breakers.WorkspaceOpen,
		DeploymentOpen: breakers.DeploymentOpen,
		EgressBlocked:  breakers.EgressBlocked,
	}
	return &out, nil
}

// RestSyncSnapshot reads the same row without the lock. The verify path uses
// it because it never writes the lease.
func RestSyncSnapshot(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, nowMS int64) (*domain.SyncSnapshot, error) {
	return loadSyncSnapshot(ctx, tx, orgID, storeUUID, nowMS, false)
}

// landSyncHold is the one writer of the hold axis. `until` may be nil only for
// open-ended holds (`disabled`); the lease clears with it.
func landSyncHold(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, hold string, untilMS *int64, reason string) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET hold = $3, hold_until_ms = $4, hold_reason = $5,
		       next_due_at_ms = COALESCE($4, next_due_at_ms),
		       inflight_token = NULL, inflight_until_ms = NULL
		 WHERE store_id = $1::uuid AND org_id = $2`,
		state.StoreUUID, state.OrgID, hold, untilMS, reason)
	return err
}

// spendSyncCall books one Seller call before it leaves. Rollover and increment
// ride one statement, so a fresh day never leaves a ledger with zero counters
// and an unchanged date. A crash after this point keeps the charge: the budget
// may over-count, never under-count.
func spendSyncCall(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, purpose domain.SyncPurpose, dayKey string) error {
	reconcile, manual := 0, 0
	if purpose == domain.PurposeManual {
		manual = 1
	} else {
		reconcile = 1
	}
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync SET
		       calls_day = $3::date,
		       calls_reconcile = CASE WHEN calls_day = $3::date
		                              THEN calls_reconcile ELSE 0 END + $4,
		       calls_manual    = CASE WHEN calls_day = $3::date
		                              THEN calls_manual    ELSE 0 END + $5
		 WHERE store_id = $1::uuid AND org_id = $2`,
		storeUUID, orgID, dayKey, reconcile, manual)
	return err
}

// refundSyncCall gives a charge back when the call provably never happened.
// The day key is the one the charge landed on: a rolled-over counter is never
// refunded.
func refundSyncCall(ctx context.Context, tx pgx.Tx, orgID int64, storeUUID string, purpose domain.SyncPurpose, dayKey string) error {
	column := "calls_reconcile"
	if purpose == domain.PurposeManual {
		column = "calls_manual"
	}
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync SET
		       calls_day = CASE WHEN calls_reconcile + calls_manual <= 1
		                        THEN NULL ELSE calls_day END,
		       `+column+` = GREATEST(`+column+` - 1, 0)
		 WHERE store_id = $1::uuid AND org_id = $2
		   AND calls_day = $3::date AND `+column+` > 0`,
		storeUUID, orgID, dayKey)
	return err
}

// claimSyncLease takes the inflight lease after the charge. `next_due_at_ms`
// holds the watchdog deadline, so a chain whose Job dies for good is
// rescannable by the time the lease expires.
func claimSyncLease(ctx context.Context, tx pgx.Tx, storeUUID string, orgID int64, token string, untilMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET inflight_token = $3, inflight_until_ms = $4, next_due_at_ms = $4
		 WHERE store_id = $1::uuid AND org_id = $2`,
		storeUUID, orgID, token, untilMS)
	return err
}

// clearSyncLease drops this token's lease. The token predicate is the fence:
// a successor that already took the row is left alone.
func clearSyncLease(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET inflight_token = NULL, inflight_until_ms = NULL
		 WHERE store_id = $1::uuid AND org_id = $2 AND inflight_token = $3::uuid`,
		state.StoreUUID, state.OrgID, token)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// landSyncPass writes one listing landing: the staging page and the pass
// counter bump ride the same statement pair as the fence, so "the page exists"
// and "the counter knows it" are one fact.
func landSyncPass(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token, pass string, cursor *string, pageNo int32, archived bool, productIDs []int64, nowMS int64) (bool, error) {
	if pageNo >= 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.store_product_pass_pages
			       (store_pk, generation, page_no, archived, product_ids)
			VALUES ($1, $2, $3, $4, $5)`,
			state.StorePK, state.RefreshGeneration, pageNo, archived, productIDs); err != nil {
			return false, err
		}
	}
	liveBump, archivedBump := 0, 0
	if pageNo >= 0 {
		if archived {
			archivedBump = 1
		} else {
			liveBump = 1
		}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET pass = $3, cursor_last_id = $4,
		       pass_pages_live = pass_pages_live + $5,
		       pass_pages_archived = pass_pages_archived + $6,
		       consecutive_failures = 0,
		       hold = 'none', hold_until_ms = NULL, hold_reason = NULL,
		       next_due_at_ms = $7,
		       inflight_token = NULL, inflight_until_ms = NULL
		 WHERE store_id = $8::uuid AND org_id = $9
		   AND inflight_token = $10 AND refresh_generation = $11
		   AND cursor_last_id IS NOT DISTINCT FROM $12`,
		state.StoreUUID, state.OrgID, pass, cursor, liveBump, archivedBump,
		nowMS+domain.ChainWatchdogMS, state.StoreUUID, state.OrgID,
		token, state.RefreshGeneration, state.CursorLastID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// stageSyncListing mirrors one listing page's ids. The listing carries no
// status texts, so new rows land on the placeholder combination (classified
// `hidden`) until the detail pass replaces it. An existing row keeps its
// detailed status unless the archive axis flipped — an archived product gets
// no detail pass, so the flip must re-pin the placeholder, and `content_hash
// = 0` forces the next detail landing to rewrite.
func stageSyncListing(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, archived bool, productIDs []int64, offerIDs []string) error {
	if len(productIDs) == 0 {
		return nil
	}
	statusID, err := ensureStatusID(ctx, tx, archived, "", "", "", "")
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO public.store_products AS sp
		       (org_id, store_pk, product_id, offer_id, status_id, content_hash)
		SELECT $1, $2, product_id, offer_id, $5, 0
		  FROM unnest($3::bigint[], $4::text[]) AS t(product_id, offer_id)
		ON CONFLICT (store_pk, product_id) DO UPDATE SET
		       offer_id = EXCLUDED.offer_id,
		       status_id = CASE WHEN (SELECT d.is_archived FROM public.ozon_product_status d
		                              WHERE d.id = sp.status_id) IS DISTINCT FROM $6
		                        THEN EXCLUDED.status_id ELSE sp.status_id END,
		       content_hash = CASE WHEN (SELECT d.is_archived FROM public.ozon_product_status d
		                                 WHERE d.id = sp.status_id) IS DISTINCT FROM $6
		                           THEN 0 ELSE sp.content_hash END,
		       gone_at_ms = NULL
		 WHERE sp.offer_id IS DISTINCT FROM EXCLUDED.offer_id
		    OR sp.gone_at_ms IS NOT NULL
		    OR (SELECT d.is_archived FROM public.ozon_product_status d
		        WHERE d.id = sp.status_id) IS DISTINCT FROM $6`,
		state.OrgID, state.StorePK, productIDs, offerIDs, statusID, archived)
	return err
}

// pendingDetailPage is the lowest live staging page this generation has not
// detailed. "Pending detail" is the staging table, not a row predicate:
// archived products never come here, the listing already pinned their state.
func pendingDetailPage(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) (int32, []int64, bool, error) {
	var pageNo int32
	var ids []int64
	err := tx.QueryRow(ctx, `
		SELECT page_no, product_ids
		  FROM public.store_product_pass_pages
		 WHERE store_pk = $1 AND generation = $2
		   AND archived = false AND detailed_at_ms IS NULL
		 ORDER BY page_no
		 LIMIT 1`, state.StorePK, state.RefreshGeneration).Scan(&pageNo, &ids)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, false, nil
	}
	if err != nil {
		return 0, nil, false, err
	}
	return pageNo, ids, true, nil
}

// landSyncDetail writes one chunk's answers, stamps the unanswered ids, and
// advances the pass. The page is marked read even when nothing answered:
// otherwise one deleted product would pin the pending set forever.
func landSyncDetail(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, pageNo int32, products []domain.SellerProduct, unanswered []int64, nowMS int64) (bool, error) {
	if err := UpsertProductsTx(ctx, tx, state.OrgID, state.StorePK, state.StoreUUID, products, nowMS); err != nil {
		return false, err
	}
	if len(unanswered) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE public.store_products SET refreshed_at_ms = $4
			 WHERE store_pk = $1 AND org_id = $2 AND product_id = ANY($3::bigint[])`,
			state.StorePK, state.OrgID, unanswered, nowMS); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.store_product_pass_pages SET detailed_at_ms = $3
		 WHERE store_pk = $1 AND generation = $2 AND page_no = $4 AND archived = false`,
		state.StorePK, state.RefreshGeneration, nowMS, pageNo); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET consecutive_failures = 0,
		       hold = 'none', hold_until_ms = NULL, hold_reason = NULL,
		       next_due_at_ms = $3,
		       inflight_token = NULL, inflight_until_ms = NULL
		 WHERE store_id = $1::uuid AND org_id = $2
		   AND inflight_token = $4 AND refresh_generation = $5
		   AND cursor_last_id IS NOT DISTINCT FROM $6`,
		state.StoreUUID, state.OrgID, nowMS+domain.ChainWatchdogMS,
		token, state.RefreshGeneration, state.CursorLastID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// syncCountsSelect is the eight `count_*` aggregates. `total` is 「所有」
// (not archived, not gone), and zero_stock is a flag on on_sale, not a bucket.
// Finalize and the migration backfill publish this exact select; a second copy
// would drift the tabs.
const syncCountsSelect = `count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state != 'archived') AS total,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state = 'on_sale') AS on_sale,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state = 'processing') AS processing,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state = 'hidden') AS hidden,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state = 'moderation_failed') AS moderation_failed,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state = 'on_sale'
	                                  AND sp.stock_present = 0) AS zero_stock,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NULL
	                                  AND d.state = 'archived') AS archived,
	       count(*) FILTER (WHERE sp.gone_at_ms IS NOT NULL) AS delisted`

// stagingCounts verifies the persisted page counters against the staging
// table. The table is UNLOGGED: a crashed process empties it, and guessing
// "gone" over missing pages would delete products that are simply unlisted
// this round.
func stagingCounts(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) (live, archived int64, err error) {
	err = tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE NOT archived), count(*) FILTER (WHERE archived)
		  FROM public.store_product_pass_pages
		 WHERE store_pk = $1 AND generation = $2`,
		state.StorePK, state.RefreshGeneration).Scan(&live, &archived)
	return live, archived, err
}

// voidSyncGeneration clears a generation whose witness pages are missing. The
// row keeps its counts: the previous generation's summary still stands.
func voidSyncGeneration(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, nextDueMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET pass = 'none', cursor_last_id = NULL,
		       generation_started_at_ms = NULL,
		       pass_pages_live = 0, pass_pages_archived = 0,
		       hold_reason = 'staging_lost', next_due_at_ms = $1,
		       inflight_token = NULL, inflight_until_ms = NULL
		 WHERE store_id = $2::uuid AND org_id = $3
		   AND inflight_token = $4 AND refresh_generation = $5
		   AND cursor_last_id IS NOT DISTINCT FROM $6`,
		nextDueMS, state.StoreUUID, state.OrgID,
		token, state.RefreshGeneration, state.CursorLastID)
	return err
}

// markGoneSyncProducts publishes the generation's disappearance fact:
// everything the listing did not see is gone. The staging pages are the
// witness, archived pages included.
func markGoneSyncProducts(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, nowMS int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.store_products sp SET gone_at_ms = $3
		 WHERE sp.store_pk = $1 AND sp.org_id = $2
		   AND sp.gone_at_ms IS NULL
		   AND NOT EXISTS (
		       SELECT 1 FROM public.store_product_pass_pages pg
		        WHERE pg.store_pk = sp.store_pk
		          AND pg.generation = $4
		          AND sp.product_id = ANY(pg.product_ids))`,
		state.StorePK, state.OrgID, nowMS, state.RefreshGeneration)
	return err
}

// commitSyncGeneration is the whole-or-nothing commit behind the fence. The
// counts and `gone_at_ms` swap only here, only when the generation finished:
// a failed earlier layer leaves the previous summary standing, never a
// half-committed zero.
func commitSyncGeneration(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, nowMS int64, nextDueMS int64) (bool, error) {
	tag, err := tx.Exec(ctx, `
		WITH counts AS (
		    SELECT `+syncCountsSelect+`
		      FROM public.store_products sp
		      JOIN public.ozon_product_status d ON d.id = sp.status_id
		     WHERE sp.store_pk = $1 AND sp.org_id = $2
		)
		UPDATE public.store_product_sync SET
		       pass = 'none',
		       cursor_last_id = NULL,
		       pass_pages_live = 0, pass_pages_archived = 0,
		       count_total = counts.total,
		       count_on_sale = counts.on_sale,
		       count_processing = counts.processing,
		       count_hidden = counts.hidden,
		       count_moderation_failed = counts.moderation_failed,
		       count_zero_stock = counts.zero_stock,
		       count_archived = counts.archived,
		       count_delisted = counts.delisted,
		       last_full_sync_at_ms = $3,
		       consecutive_failures = 0,
		       hold = 'none', hold_until_ms = NULL, hold_reason = NULL,
		       next_due_at_ms = $4,
		       inflight_token = NULL, inflight_until_ms = NULL
		  FROM counts
		 WHERE store_id = $6::uuid AND org_id = $2
		   AND inflight_token = $7 AND refresh_generation = $5
		   AND cursor_last_id IS NOT DISTINCT FROM $8`,
		state.StorePK, state.OrgID, nowMS, nextDueMS,
		state.RefreshGeneration, state.StoreUUID, token, state.CursorLastID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// dropStagingPages deletes a committed generation's witness pages.
func dropStagingPages(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) error {
	_, err := tx.Exec(ctx, `
		DELETE FROM public.store_product_pass_pages
		 WHERE store_pk = $1 AND generation = $2`,
		state.StorePK, state.RefreshGeneration)
	return err
}

// landSyncMetrics writes one funnel page and its stamps. The upsert and the
// sync-row stamp ride the caller's commit, so "the generation closed" and "its
// funnel page landed" publish together.
func landSyncMetrics(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, outcome domain.SyncMetricsOutcome, stamp domain.FxStamp, nowMS int64) error {
	switch {
	case outcome.Fetched != nil:
		page := outcome.Fetched
		if len(page.Rows) > 0 {
			var quote *string
			var rate *float64
			var asOf, source *string
			if stamp.Kind == domain.FxSet {
				quote, rate = &stamp.Quote, &stamp.Rate
				asOf, source = &stamp.AsOf, &stamp.Source
			}
			skus := make([]int64, 0, len(page.Rows))
			hitsView := make([]float64, 0, len(page.Rows))
			sessionView := make([]float64, 0, len(page.Rows))
			hitsTocart := make([]float64, 0, len(page.Rows))
			convTocart := make([]float64, 0, len(page.Rows))
			orderedUnits := make([]float64, 0, len(page.Rows))
			revenue := make([]float64, 0, len(page.Rows))
			for _, row := range page.Rows {
				skus = append(skus, row.SKU)
				hitsView = append(hitsView, row.HitsView)
				sessionView = append(sessionView, row.SessionView)
				hitsTocart = append(hitsTocart, row.HitsTocart)
				convTocart = append(convTocart, row.ConvTocart)
				orderedUnits = append(orderedUnits, row.OrderedUnits)
				revenue = append(revenue, row.Revenue)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO public.store_product_metrics
				       (org_id, store_pk, sku, hits_view, session_view,
				        hits_tocart, conv_tocart, ordered_units, revenue,
				        period_days, through_day, fetched_at_ms, fetched_generation,
				        fx_quote, fx_rate, fx_as_of, fx_source)
				SELECT $1, $2, f.sku, f.hits_view, f.session_view,
				       f.hits_tocart, f.conv_tocart, f.ordered_units,
				       f.revenue, $4, $5::date, $6, $7,
				       $14, $15, $16::date, $17
				  FROM unnest($3::bigint[], $8::float8[], $9::float8[], $10::float8[],
				              $11::float8[], $12::float8[], $13::float8[])
				       AS f(sku, hits_view, session_view, hits_tocart,
				            conv_tocart, ordered_units, revenue)
				ON CONFLICT (store_pk, sku) DO UPDATE SET
				       org_id = EXCLUDED.org_id,
				       hits_view = EXCLUDED.hits_view,
				       session_view = EXCLUDED.session_view,
				       hits_tocart = EXCLUDED.hits_tocart,
				       conv_tocart = EXCLUDED.conv_tocart,
				       ordered_units = EXCLUDED.ordered_units,
				       revenue = EXCLUDED.revenue,
				       period_days = EXCLUDED.period_days,
				       through_day = EXCLUDED.through_day,
				       fetched_at_ms = EXCLUDED.fetched_at_ms,
				       fetched_generation = EXCLUDED.fetched_generation,
				       fx_quote = CASE WHEN $18 THEN EXCLUDED.fx_quote
				                       ELSE COALESCE(EXCLUDED.fx_quote, store_product_metrics.fx_quote) END,
				       fx_rate = CASE WHEN $18 THEN EXCLUDED.fx_rate
				                      ELSE COALESCE(EXCLUDED.fx_rate, store_product_metrics.fx_rate) END,
				       fx_as_of = CASE WHEN $18 THEN EXCLUDED.fx_as_of
				                       ELSE COALESCE(EXCLUDED.fx_as_of, store_product_metrics.fx_as_of) END,
				       fx_source = CASE WHEN $18 THEN EXCLUDED.fx_source
				                        ELSE COALESCE(EXCLUDED.fx_source, store_product_metrics.fx_source) END`,
				state.OrgID, state.StorePK, skus, domain.MetricsPeriodDays,
				page.ThroughDay, nowMS, state.RefreshGeneration,
				hitsView, sessionView, hitsTocart, convTocart, orderedUnits, revenue,
				quote, rate, asOf, source, stamp.Replace); err != nil {
				return err
			}
		}
		if err := stampSyncSiblings(ctx, tx, state, page.ThroughDay, stamp); err != nil {
			return err
		}
		// Metrics a deleted product leaves behind would sit orphaned forever;
		// SKUs of gone rows stay — their last funnel is still the truth.
		if _, err := tx.Exec(ctx, `
			DELETE FROM public.store_product_metrics m
			 WHERE m.store_pk = $1 AND m.org_id = $2
			   AND NOT EXISTS (SELECT 1 FROM public.store_products p
			                    WHERE p.store_pk = m.store_pk AND p.sku = m.sku)`,
			state.StorePK, state.OrgID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE public.store_product_sync
			   SET metrics_at_ms = $3, metrics_error = NULL, metrics_offset = $4
			 WHERE store_id = $1::uuid AND org_id = $2`,
			state.StoreUUID, state.OrgID, nowMS, page.NextOffset)
		return err
	case outcome.ErrorCode != "":
		_, err := tx.Exec(ctx, `
			UPDATE public.store_product_sync SET metrics_error = $3
			 WHERE store_id = $1::uuid AND org_id = $2`,
			state.StoreUUID, state.OrgID, outcome.ErrorCode)
		return err
	default:
		// Skipped: nothing was sent, so nothing is recorded.
		return nil
	}
}

// stampSyncSiblings fills the fx columns of rows from an earlier page of the
// same window, or clears every stamp when the store prices in rubles.
func stampSyncSiblings(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, throughDay string, stamp domain.FxStamp) error {
	switch stamp.Kind {
	case domain.FxClear:
		_, err := tx.Exec(ctx, `
			UPDATE public.store_product_metrics
			   SET fx_quote = NULL, fx_rate = NULL, fx_as_of = NULL, fx_source = NULL
			 WHERE store_pk = $1 AND org_id = $2 AND fx_quote IS NOT NULL`,
			state.StorePK, state.OrgID)
		return err
	case domain.FxSet:
		_, err := tx.Exec(ctx, `
			UPDATE public.store_product_metrics
			   SET fx_quote = $3, fx_rate = $4, fx_as_of = $5::date, fx_source = $6
			 WHERE store_pk = $1 AND org_id = $2
			   AND through_day = $7::date AND fx_rate IS NULL`,
			state.StorePK, state.OrgID, stamp.Quote, stamp.Rate,
			stamp.AsOf, stamp.Source, throughDay)
		return err
	default:
		return nil
	}
}

// recordSyncFailure lands a refusal on the row: the hold, the streak, and the
// lease clear ride the fence. The charge goes back behind the same fence,
// because the call was refused.
func recordSyncFailure(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot, token string, landing domain.FailureLanding, nowMS int64) error {
	failures := 0
	if landing.Failure {
		failures = 1
	}
	_, err := tx.Exec(ctx, `
		UPDATE public.store_product_sync
		   SET hold = $3, hold_until_ms = $4, hold_reason = $5,
		       consecutive_failures = consecutive_failures + $6,
		       next_due_at_ms = $4,
		       inflight_token = NULL, inflight_until_ms = NULL
		 WHERE store_id = $1::uuid AND org_id = $2
		   AND inflight_token = $7 AND refresh_generation = $8
		   AND cursor_last_id IS NOT DISTINCT FROM $9`,
		state.StoreUUID, state.OrgID, landing.Hold, landing.UntilMS, landing.Reason,
		failures, token, state.RefreshGeneration, state.CursorLastID)
	return err
}

// storeCurrencyValue reads the contract currency the fx stamp keys on.
func storeCurrencyValue(ctx context.Context, tx pgx.Tx, state domain.SyncSnapshot) (*string, error) {
	var currency *string
	err := tx.QueryRow(ctx, `
		SELECT currency FROM public.store_product_sync
		 WHERE store_id = $1::uuid AND org_id = $2`, state.StoreUUID, state.OrgID).Scan(&currency)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return currency, err
}

// parseInt64 reads a jsonb scalar that may have arrived as a number or a
// string.
func parseInt64(raw string) (int64, bool) {
	if raw == "" {
		return 0, false
	}
	var digits int64
	negative := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if i == 0 && (c == '-' || c == '+') {
			negative = c == '-'
			continue
		}
		if c < '0' || c > '9' {
			return 0, false
		}
		if digits > (1<<62)/10 {
			return 0, false
		}
		digits = digits*10 + int64(c-'0')
	}
	if negative {
		digits = -digits
	}
	return digits, true
}
