package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/billing/domain"
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

const confirmAPIPath = "/api/admin/orders/{public_id}/confirm"

// settleCredit is the credit_cents>0 member-seat settle. credit_cents==0 stays
// on settleSeats. Wallet and platform goods return before this function.
func (r *Entitlement) settleCredit(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, held corerepo.Lease, order loadedOrder) error {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT credit_lots FROM payment_orders WHERE id = $1`, order.id).Scan(&raw); err != nil {
		return err
	}
	lines, err := domain.ParseSeatCreditLines(raw)
	if err != nil {
		return corecontract.Fulfillment(err.Error())
	}
	if len(lines) > 0 {
		if err := consumeSeatCredit(ctx, tx, order.orgID, order.id, lines); err != nil {
			return err
		}
	}
	applied, err := applyMemberSeats(ctx, tx, order)
	if err != nil {
		return err
	}
	ids := make([]int64, 0, len(lines))
	for _, line := range lines {
		ids = append(ids, line.LotID)
	}
	expiresText := ""
	if applied.expires != nil {
		expiresText = corerepo.RFC3339Millis(*applied.expires)
	}
	message, err := json.Marshal(struct {
		Plan             string  `json:"plan"`
		MemberSeats      int64   `json:"member_seats"`
		DurationDays     int32   `json:"duration_days"`
		GrossAmountCents int64   `json:"gross_amount_cents"`
		CreditCents      int64   `json:"credit_cents"`
		CreditedLotIDs   []int64 `json:"credited_lot_ids"`
		AmountCents      int64   `json:"amount_cents"`
		PlanExpiresAt    string  `json:"plan_expires_at"`
	}{applied.plan, order.seats, order.durationDays, order.amount + order.credit, order.credit, ids, order.amount, expiresText})
	if err != nil {
		return err
	}
	if err := corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "entitlement", "payment_order", order.publicID, "PUT",
		confirmAPIPath, "payment_order_settled", string(message), held); err != nil {
		return err
	}
	return settleCommission(ctx, tx, actor, held, order)
}

func consumeSeatCredit(ctx context.Context, tx pgx.Tx, orgID, orderID int64, lines []domain.SeatCreditLine) error {
	ids := make([]int64, len(lines))
	for i, line := range lines {
		ids[i] = line.LotID
	}
	rows, err := tx.Query(ctx, `
		UPDATE member_seat_lots
		   SET expires_at = LEAST(expires_at, GREATEST(starts_at, clock_timestamp()))
		 WHERE org_id = $1
		   AND id = ANY($2::bigint[])
		   AND expires_at > clock_timestamp()
		 RETURNING id`, orgID, ids)
	if err != nil {
		return err
	}
	terminated := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		terminated[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, line := range lines {
		tag, err := tx.Exec(ctx, `
			INSERT INTO member_seat_lot_credits
			       (order_id, lot_id, org_id, tier, seats, starts_at, expires_at,
			        total_days, used_days, remaining_days, lot_value_cents,
			        consumed_value_cents, terminated_at, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
			        CASE WHEN $13 THEN clock_timestamp() ELSE NULL END,
			        clock_timestamp())
			ON CONFLICT (lot_id) DO NOTHING`,
			orderID, line.LotID, orgID, line.Tier, line.Seats, line.StartsAt, line.ExpiresAt,
			line.TotalDays, line.UsedDays, line.RemainingDays, line.LotValueCents,
			line.ConsumedValueCents, terminated[line.LotID])
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return corecontract.Fulfillment(fmt.Sprintf("member-seat lot %d was already credited", line.LotID))
		}
	}
	return nil
}

type seatApplied struct {
	plan    string
	expires *time.Time
	seats   int64
}

func applyMemberSeats(ctx context.Context, tx pgx.Tx, order loadedOrder) (seatApplied, error) {
	if fault := domain.SeatApplyGate(order.plan, order.seats); fault != nil {
		return seatApplied{}, fault
	}
	var windowStart time.Time
	renewal := order.renews != nil
	if renewal {
		err := tx.QueryRow(ctx, `
			SELECT expires_at FROM member_seat_lots
			 WHERE id = $1 AND org_id = $2
			 LIMIT 1
			 FOR UPDATE`, *order.renews, order.orgID).Scan(&windowStart)
		if errors.Is(err, pgx.ErrNoRows) {
			return seatApplied{}, corecontract.Validation("VALIDATION", "续费批次不存在")
		}
		if err != nil {
			return seatApplied{}, err
		}
	} else {
		var dissolved bool
		err := tx.QueryRow(ctx, `
			SELECT dissolved_at IS NOT NULL AS dissolved
			  FROM organizations
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`, order.orgID).Scan(&dissolved)
		if errors.Is(err, pgx.ErrNoRows) {
			return seatApplied{}, corecontract.Validation("VALIDATION", "组织信息加载失败")
		}
		if err != nil {
			return seatApplied{}, err
		}
		if dissolved {
			return seatApplied{}, corecontract.Validation("VALIDATION", "工作空间已解散")
		}
		if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&windowStart); err != nil {
			return seatApplied{}, err
		}
	}
	var windowEnd time.Time
	if err := tx.QueryRow(ctx, `SELECT $1::timestamptz + make_interval(days => $2::int)`, windowStart, order.durationDays).Scan(&windowEnd); err != nil {
		return seatApplied{}, err
	}
	pendingNow := windowStart
	if renewal {
		if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&pendingNow); err != nil {
			return seatApplied{}, err
		}
	}
	if err := seatCapacity(ctx, tx, order, windowStart, windowEnd, pendingNow); err != nil {
		return seatApplied{}, err
	}
	if renewal {
		if _, err := tx.Exec(ctx, `
			INSERT INTO member_seat_lots
			       (org_id, tier, seats, starts_at, expires_at, payment_order_id, renews_lot_id, created_at)
			SELECT $1, $2, $3, start_at, start_at + make_interval(days => $5::int), $6, $7, start_at
			  FROM (SELECT $4::timestamptz AS start_at) clock`,
			order.orgID, order.plan, order.seats, windowStart, order.durationDays, order.id, *order.renews); err != nil {
			return seatApplied{}, err
		}
	} else if _, err := tx.Exec(ctx, `
		INSERT INTO member_seat_lots
		       (org_id, tier, seats, starts_at, expires_at, payment_order_id, created_at)
		SELECT $1, $2, $3, start_at, start_at + make_interval(days => $5::int), $6, start_at
		  FROM (SELECT $4::timestamptz AS start_at) clock`,
		order.orgID, order.plan, order.seats, windowStart, order.durationDays, order.id); err != nil {
		return seatApplied{}, err
	}
	applied, err := projectSeatState(ctx, tx, order.orgID)
	if err != nil {
		return seatApplied{}, err
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT active FROM plans WHERE key = $1 LIMIT 1`, order.plan).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !active) {
		return seatApplied{}, corecontract.Validation("VALIDATION", "成员名额加购项不存在或未开放")
	}
	if err != nil {
		return seatApplied{}, err
	}
	if !renewal {
		if err := reconcileMembers(ctx, tx, order.orgID, applied.seats); err != nil {
			return seatApplied{}, err
		}
		if err := reconcileStores(ctx, tx, order.orgID); err != nil {
			return seatApplied{}, err
		}
	}
	return applied, nil
}

func seatCapacity(ctx context.Context, tx pgx.Tx, order loadedOrder, start, end, pendingNow time.Time) error {
	rows, err := tx.Query(ctx, `
		SELECT seats::bigint, starts_at, expires_at
		  FROM member_seat_lots
		 WHERE org_id = $1
		   AND starts_at < $3
		   AND expires_at > $2
		   AND id <> ALL($4::bigint[])`, order.orgID, start, end, []int64{})
	if err != nil {
		return err
	}
	seats, starts, ends, err := scanSeatWindows(rows)
	if err != nil {
		return err
	}
	pending, err := tx.Query(ctx, `
		SELECT COALESCE(member_seats, 0)::bigint, COALESCE(duration_days, 1)::int
		  FROM payment_orders
		 WHERE org_id = $1
		   AND product = 'member_seats'
		   AND status = 'pending'
		   AND id IS DISTINCT FROM $2`, order.orgID, order.id)
	if err != nil {
		return err
	}
	type pendingOrder struct {
		seats int64
		days  int32
	}
	var waiting []pendingOrder
	for pending.Next() {
		var row pendingOrder
		if err := pending.Scan(&row.seats, &row.days); err != nil {
			pending.Close()
			return err
		}
		if row.days < 1 {
			row.days = 1
		}
		waiting = append(waiting, row)
	}
	pending.Close()
	if err := pending.Err(); err != nil {
		return err
	}
	for _, row := range waiting {
		var pendingEnd time.Time
		if err := tx.QueryRow(ctx, `SELECT $1::timestamptz + make_interval(days => $2::int)`, pendingNow, row.days).Scan(&pendingEnd); err != nil {
			return err
		}
		seats = append(seats, row.seats)
		starts = append(starts, pendingNow)
		ends = append(ends, pendingEnd)
	}
	seats = append(seats, order.seats)
	starts = append(starts, start)
	ends = append(ends, end)
	if domain.PeakSeats(starts, ends, seats) > 20 {
		return corecontract.Validation("VALIDATION", "一个工作空间最多 20 个成员名额")
	}
	return nil
}

func scanSeatWindows(rows pgx.Rows) ([]int64, []time.Time, []time.Time, error) {
	defer rows.Close()
	var seats []int64
	var starts, ends []time.Time
	for rows.Next() {
		var n int64
		var a, b time.Time
		if err := rows.Scan(&n, &a, &b); err != nil {
			return nil, nil, nil, err
		}
		seats = append(seats, n)
		starts = append(starts, a)
		ends = append(ends, b)
	}
	return seats, starts, ends, rows.Err()
}

func projectSeatState(ctx context.Context, tx pgx.Tx, orgID int64) (seatApplied, error) {
	var override *int64
	if err := tx.QueryRow(ctx, `SELECT member_seat_limit_override FROM organizations WHERE id = $1`, orgID).Scan(&override); err != nil {
		return seatApplied{}, err
	}
	rows, err := tx.Query(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now)
		SELECT tier, COALESCE(SUM(seats), 0)::bigint AS seats
		  FROM member_seat_lots
		 CROSS JOIN clock
		 WHERE org_id = $1
		   AND starts_at <= clock.now
		   AND expires_at > clock.now
		 GROUP BY tier`, orgID)
	if err != nil {
		return seatApplied{}, err
	}
	rank := 0
	var purchased int64
	for rows.Next() {
		var tier string
		var seats int64
		if err := rows.Scan(&tier, &seats); err != nil {
			rows.Close()
			return seatApplied{}, err
		}
		purchased += seats
		if tierRank(tier) > rank {
			rank = tierRank(tier)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return seatApplied{}, err
	}
	var expires *time.Time
	if err := tx.QueryRow(ctx, `
		WITH clock AS (SELECT clock_timestamp() AS now)
		SELECT MAX(expires_at)
		  FROM member_seat_lots
		 CROSS JOIN clock
		 WHERE org_id = $1 AND expires_at > clock.now`, orgID).Scan(&expires); err != nil {
		return seatApplied{}, err
	}
	effective := purchased
	if effective < 1 {
		effective = 1
	}
	if override != nil {
		effective = *override
	}
	plan := tierKey(rank)
	if _, err := tx.Exec(ctx, `
		UPDATE organizations
		   SET plan = $1,
		       seat_limit = $2,
		       plan_expires_at = $3,
		       quota_revision = quota_revision + 1,
		       updated_at = clock_timestamp()
		 WHERE id = $4
		   AND (plan IS DISTINCT FROM $1
		        OR seat_limit IS DISTINCT FROM $2
		        OR plan_expires_at IS DISTINCT FROM $3)`, plan, effective, expires, orgID); err != nil {
		return seatApplied{}, err
	}
	return seatApplied{plan: plan, expires: expires, seats: effective}, nil
}

func tierRank(tier string) int {
	switch tier {
	case "ultra":
		return 3
	case "max":
		return 2
	case "pro":
		return 1
	default:
		return 0
	}
}

func tierKey(rank int) string {
	switch rank {
	case 3:
		return "ultra"
	case 2:
		return "max"
	case 1:
		return "pro"
	default:
		return "lite"
	}
}

func reconcileMembers(ctx context.Context, tx pgx.Tx, orgID, seatLimit int64) error {
	if seatLimit < 1 {
		seatLimit = 1
	}
	rows, err := tx.Query(ctx, `
		SELECT id, user_id, role, manual_disabled, quota_suspended
		  FROM organization_members
		 WHERE org_id = $1
		 ORDER BY join_order ASC, id ASC`, orgID)
	if err != nil {
		return err
	}
	type member struct {
		id, user int64
		role     string
		manual   bool
		quota    bool
	}
	var members []member
	for rows.Next() {
		var row member
		if err := rows.Scan(&row.id, &row.user, &row.role, &row.manual, &row.quota); err != nil {
			rows.Close()
			return err
		}
		members = append(members, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var used int64
	var suspend, restore, sessions []int64
	for _, row := range members {
		if row.role == "owner" {
			used++
			if row.quota {
				restore = append(restore, row.id)
			}
			continue
		}
		if row.manual {
			continue
		}
		if used < seatLimit {
			used++
			if row.quota {
				restore = append(restore, row.id)
			}
			continue
		}
		if !row.quota {
			suspend = append(suspend, row.id)
			sessions = append(sessions, row.user)
		}
	}
	if len(suspend) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE organization_members
			   SET quota_suspended = true, updated_at = clock_timestamp()
			 WHERE id = ANY($1::bigint[]) AND role <> 'owner'`, suspend); err != nil {
			return err
		}
	}
	if len(restore) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE organization_members
			   SET quota_suspended = false, updated_at = clock_timestamp()
			 WHERE id = ANY($1::bigint[])`, restore); err != nil {
			return err
		}
	}
	if len(sessions) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM account_sessions WHERE user_id = ANY($1::bigint[])`, sessions); err != nil {
			return err
		}
	}
	return nil
}

func reconcileStores(ctx context.Context, tx pgx.Tx, orgID int64) error {
	var override, maxStores *int64
	err := tx.QueryRow(ctx, `
		SELECT o.store_limit_override, p.max_stores
		  FROM organizations o
		  LEFT JOIN plans p ON p.key = o.plan
		 WHERE o.id = $1`, orgID).Scan(&override, &maxStores)
	if errors.Is(err, pgx.ErrNoRows) {
		return corecontract.Fulfillment("Workspace 不存在")
	}
	if err != nil {
		return err
	}
	limit := int64(0)
	if override != nil {
		limit = *override
	} else if maxStores != nil {
		limit = *maxStores
	}
	if limit < 1 {
		limit = 1
	}
	rows, err := tx.Query(ctx, `
		SELECT s.id, s.create_order, s.manual_disabled, s.quota_suspended,
		       COALESCE(c.last_leased_at_ms, 0)
		  FROM organization_stores s
		  LEFT JOIN store_seller_credentials c
		    ON c.store_id = s.id
		   AND c.credential_revision = s.credential_revision
		 WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
		 ORDER BY COALESCE(c.last_leased_at_ms, 0) DESC, s.create_order ASC, s.id ASC
		 FOR UPDATE OF s`, orgID)
	if err != nil {
		return err
	}
	type store struct {
		id, order, last int64
		manual, quota   bool
	}
	var stores []store
	for rows.Next() {
		var row store
		if err := rows.Scan(&row.id, &row.order, &row.manual, &row.quota, &row.last); err != nil {
			rows.Close()
			return err
		}
		stores = append(stores, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var kept int64
	var suspend, restore []int64
	for _, row := range stores {
		if row.manual {
			continue
		}
		want := true
		if kept < limit {
			kept++
			want = false
		}
		if want && !row.quota {
			suspend = append(suspend, row.id)
		}
		if !want && row.quota {
			restore = append(restore, row.id)
		}
	}
	if err := setStoreQuota(ctx, tx, suspend, true); err != nil {
		return err
	}
	return setStoreQuota(ctx, tx, restore, false)
}

func setStoreQuota(ctx context.Context, tx pgx.Tx, ids []int64, suspended bool) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		UPDATE organization_stores
		   SET quota_suspended = $1,
		       revision = revision + 1,
		       updated_at = clock_timestamp()
		 WHERE id = ANY($2::bigint[])
		   AND deleted_at_ms IS NULL
		   AND quota_suspended IS DISTINCT FROM $1`, suspended, ids)
	return err
}

func settleCommission(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, held corerepo.Lease, order loadedOrder) error {
	var bps, minOrder, validity, minWithdraw int64
	err := tx.QueryRow(ctx, `
		SELECT default_rebate_bps::bigint, min_order_cents,
		       attribution_validity_days::bigint, min_withdraw_cents
		  FROM agent_rebate_policy`).Scan(&bps, &minOrder, &validity, &minWithdraw)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("agent_rebate_policy row missing")
	}
	if err != nil {
		return err
	}
	_ = minWithdraw
	if order.amount < minOrder {
		return nil
	}
	var ownerID int64
	var email string
	var invited *int64
	var attribution *int64
	var expired bool
	err = tx.QueryRow(ctx, `
		SELECT o.owner_user_id, u.email, u.invited_by_agent_user_id, u.agent_attribution_bps,
		       (u.agent_attributed_at IS NOT NULL
		        AND $2::bigint > 0
		        AND u.agent_attributed_at + make_interval(days => $2::int) < now())
		  FROM organizations o
		  JOIN account_users u ON u.id = o.owner_user_id
		 WHERE o.id = $1`, order.orgID, validity).Scan(&ownerID, &email, &invited, &attribution, &expired)
	if errors.Is(err, pgx.ErrNoRows) || invited == nil {
		return nil
	}
	if err != nil {
		return err
	}
	var status *string
	err = tx.QueryRow(ctx, `SELECT status FROM agents WHERE user_id = $1 FOR UPDATE`, *invited).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		status = nil
		err = nil
	}
	if err != nil {
		return err
	}
	var exists int
	err = tx.QueryRow(ctx, `
		SELECT 1 FROM agent_commissions
		 WHERE invitee_user_id = $1 OR payment_order_id = $2
		 LIMIT 1`, ownerID, order.id).Scan(&exists)
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	decision := domain.DecideCommission(order.amount, bps, status != nil, deref(status), attribution, expired)
	var ledger any
	rowStatus := "skipped"
	amount := int64(0)
	note := decision.Note
	if decision.Credited {
		rowStatus = "credited"
		amount = decision.Amount
		ledger = "agent_commission:" + order.publicID
		note = domain.CommissionNote(order.publicID)
	}
	var commissionID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO agent_commissions
		       (agent_user_id, invitee_user_id, payment_order_id, org_id,
		        order_amount_cents, rebate_bps, amount_cents, ledger_idempotency_key,
		        status, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id`,
		*invited, ownerID, order.id, order.orgID, order.amount, decision.BPS, amount, ledger, rowStatus, note).Scan(&commissionID); err != nil {
		return err
	}
	if decision.Credited {
		if err := creditCommissionWallet(ctx, tx, *invited, commissionID, amount, ledger.(string), note); err != nil {
			return err
		}
	}
	action := "agent_commission_skipped"
	if decision.Credited {
		action = "agent_commission_credited"
	}
	body, err := json.Marshal(struct {
		AgentUserID      int64  `json:"agent_user_id"`
		InviteeUserID    int64  `json:"invitee_user_id"`
		PayingOrgID      int64  `json:"paying_org_id"`
		Product          string `json:"product"`
		OrderAmountCents int64  `json:"order_amount_cents"`
		RebateBPS        int64  `json:"rebate_bps"`
		AmountCents      int64  `json:"amount_cents"`
		Note             string `json:"note"`
	}{*invited, ownerID, order.orgID, order.product, order.amount, decision.BPS, amount, note})
	if err != nil {
		return err
	}
	if err := corerepo.AuditBill(ctx, tx, order.orgID, actor.UserID, "agent_commissions", "agent_commission", fmt.Sprint(commissionID), "PUT",
		confirmAPIPath, action, string(body), held); err != nil {
		return err
	}
	if !decision.Credited {
		return nil
	}
	payload, err := domain.CommissionPayload(amount, order.publicID, email)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO notifications (uuid, user_id, kind, payload, created_at)
		VALUES (gen_random_uuid(), $1, 'agent_commission_credited', $2::jsonb, clock_timestamp())`,
		*invited, string(payload))
	return err
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func creditCommissionWallet(ctx context.Context, tx pgx.Tx, userID, commissionID, amount int64, key, note string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO agent_commission_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		return err
	}
	var balance, held int64
	if err := tx.QueryRow(ctx, `
		SELECT balance_cents, held_cents
		  FROM agent_commission_wallets
		 WHERE user_id = $1
		 FOR UPDATE`, userID).Scan(&balance, &held); err != nil {
		return err
	}
	var existingAmount int64
	var existingCommission *int64
	err := tx.QueryRow(ctx, `
		SELECT amount_cents, commission_id
		  FROM agent_commission_ledger
		 WHERE user_id = $1 AND entry_type = 'commission' AND idempotency_key = $2`,
		userID, key).Scan(&existingAmount, &existingCommission)
	if err == nil {
		if existingAmount == amount && existingCommission != nil && *existingCommission == commissionID {
			return nil
		}
		return fmt.Errorf("commission ledger mismatch")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	next := balance + amount
	if next < 0 {
		return fmt.Errorf("commission wallet would be negative")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE agent_commission_wallets
		   SET balance_cents = $2, held_cents = $3,
		       version = version + 1, updated_at = clock_timestamp()
		 WHERE user_id = $1`, userID, next, held); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO agent_commission_ledger
		       (user_id, entry_type, idempotency_key, amount_cents, held_delta_cents,
		        balance_before_cents, balance_after_cents,
		        held_before_cents, held_after_cents,
		        commission_id, withdrawal_id, note)
		VALUES ($1, 'commission', $2, $3, 0, $4, $5, $6, $7, $8, NULL, $9)`,
		userID, key, amount, balance, next, held, held, commissionID, note)
	return err
}
