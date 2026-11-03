package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// SettleFirstOrderCommission records the first qualifying paid order in the payment transaction.
// actorID zero uses the payer for provider callbacks and payment replay.
func SettleFirstOrderCommission(ctx context.Context, tx pgx.Tx, orderID, actorID int64, method, path string) error {
	var order struct {
		id, orgID, amount, payer int64
		publicID, product        string
	}
	if err := tx.QueryRow(ctx, `SELECT id, org_id, amount_cents, created_by_user_id, public_id, product
  FROM payment_orders WHERE id=$1 AND status='paid' FOR UPDATE`, orderID).Scan(
		&order.id, &order.orgID, &order.amount, &order.payer, &order.publicID, &order.product); err != nil {
		return err
	}
	if actorID == 0 {
		actorID = order.payer
	}

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
	leaseID, fence := writer.AuditArgs(tx)
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs
  (org_id,user_id,module,entity_type,entity_id,api_method,api_path,action,status,result,message,
   shop_id,created_at_ms,created_at,actor_kind,support_grant_id,writer_lease_id,writer_fence_token)
  VALUES($1,$2,'agent_commissions','agent_commission',$3,$4,$5,$6,'success','applied',$7,
   NULL,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,clock_timestamp(),'user',NULL,$8,$9)`,
		order.orgID, actorID, fmt.Sprint(commissionID), method, path, action, string(body), leaseID, fence); err != nil {
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
