package agentrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// agentProjectionSQL is the agent projection plus the user filter. The
// commission list SQL is assembled separately; its SELECT list is the
// CommissionProjection fields the handler maps.
const agentProjectionSQL = `
SELECT lower(u.uuid::text) AS user_uuid,
       u.email,
       u.name,
       a.invite_code,
       a.status,
       a.payout_channel,
       a.payout_account,
       a.payout_real_name,
       COALESCE(w.balance_cents, 0)::bigint AS wallet_balance_cents,
       COALESCE(w.held_cents, 0)::bigint AS wallet_held_cents,
       (SELECT count(*) FROM account_users i
         WHERE i.invited_by_agent_user_id = a.user_id)::bigint AS invitee_count,
       (SELECT count(*) FROM agent_commissions c
         WHERE c.agent_user_id = a.user_id AND c.status = 'credited')::bigint AS credited_count,
       (SELECT count(*) FROM agent_commissions c
         WHERE c.agent_user_id = a.user_id AND c.status = 'skipped')::bigint AS skipped_count,
       COALESCE((SELECT sum(c.amount_cents) FROM agent_commissions c
         WHERE c.agent_user_id = a.user_id AND c.status = 'credited'), 0)::bigint
         AS credited_total_cents,
       to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       to_char(a.review_flagged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         AS review_flagged_at
FROM agents a
JOIN account_users u ON u.id = a.user_id
LEFT JOIN agent_commission_wallets w ON w.user_id = a.user_id
WHERE a.user_id = $1
LIMIT 1`

// commissionSQL is the workbench list. The columns are the ones
// AgentCommissionView reads, the alias is c, and the joins are the tables
// named in the spec (account_users for the invitee email, organizations for
// the workspace name, payment_orders for product).
const commissionSQL = `
SELECT c.id,
       iu.email AS invitee_email,
       o.name AS workspace_name,
       po.product,
       c.order_amount_cents,
       c.rebate_bps::bigint AS rebate_bps,
       c.amount_cents,
       c.status,
       c.note,
       to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM agent_commissions c
JOIN account_users iu ON iu.id = c.invitee_user_id
JOIN organizations o ON o.id = c.org_id
JOIN LATERAL public.billing_payment_order_brief(c.payment_order_id) po ON true
WHERE c.agent_user_id = $1
ORDER BY c.created_at DESC, c.id DESC
LIMIT $2`

const ledgerSQL = `
SELECT entry_type, amount_cents, held_delta_cents, balance_after_cents, note,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
FROM agent_commission_ledger
WHERE user_id = $1
ORDER BY created_at DESC, id DESC
LIMIT $2`

const withdrawalSQL = `
SELECT w.public_id, w.amount_cents, w.channel, w.account, w.real_name,
       w.status, w.reference, w.reject_reason,
       to_char(w.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
       to_char(w.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
FROM agent_withdrawals w
WHERE w.user_id = $1
ORDER BY w.requested_at DESC, w.id DESC
LIMIT $2`

// Workbench is GET /api/agent's reads: projection, policy, commissions, then
// the owned-workspace EXISTS. Each statement autocommits. A missing agent is
// ErrNotAgent and does not read the policy.
func (r *Repo) Workbench(ctx context.Context, userID int64) (domain.Workbench, error) {
	if err := r.ready(); err != nil {
		return domain.Workbench{}, err
	}
	return r.workbench(ctx, userID)
}

func (r *Repo) workbench(ctx context.Context, userID int64) (domain.Workbench, error) {
	var out domain.Workbench
	var (
		userUUID, email, name, invite, status, createdAt string
		ch, acct, real, flagged                          *string
		bal, held                                        int64
	)
	err := r.pool.QueryRow(ctx, agentProjectionSQL, userID).Scan(
		&userUUID, &email, &name, &invite, &status, &ch, &acct, &real,
		&bal, &held, &out.InviteeCount, &out.CreditedCount, &out.SkippedCount,
		&out.CreditedTotal, &createdAt, &flagged,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Workbench{}, contract.ErrNotAgent
	}
	if err != nil {
		return domain.Workbench{}, mapDB(err)
	}
	agent := &domain.Agent{UserID: userID, InviteCode: invite, Status: status}
	if ch != nil && acct != nil && real != nil {
		agent.Payout = domain.Payout{Channel: *ch, Account: *acct, RealName: *real}
	}
	out.Agent = agent
	out.Wallet = domain.Wallet{BalanceCents: bal, HeldCents: held}
	out.AvailableCents = bal - held
	var bps, days int64
	err = r.pool.QueryRow(ctx, `
		SELECT default_rebate_bps::bigint AS bps,
		       min_order_cents,
		       attribution_validity_days::bigint AS validity_days,
		       min_withdraw_cents
		FROM agent_rebate_policy`).Scan(
		&bps, &out.Policy.MinOrderCents, &days, &out.Policy.MinWithdrawCents,
	)
	if err != nil {
		return domain.Workbench{}, mapDB(err)
	}
	out.Policy.DefaultRebateBps = int32(bps)
	out.Policy.AttributionValidityDays = int32(days)
	rows, err := r.pool.Query(ctx, commissionSQL, userID, domain.CommissionWindow)
	if err != nil {
		return domain.Workbench{}, mapDB(err)
	}
	defer rows.Close()
	out.Commissions = []domain.CommissionView{}
	for rows.Next() {
		var c domain.CommissionView
		var email string
		if err := rows.Scan(&c.ID, &email, &c.WorkspaceName, &c.Product, &c.OrderAmountCents,
			&c.RebateBps, &c.AmountCents, &c.Status, &c.Note, &c.CreatedAt); err != nil {
			return domain.Workbench{}, mapDB(err)
		}
		c.InviteeEmail = domain.MaskEmail(email)
		out.Commissions = append(out.Commissions, c)
	}
	if err := rows.Err(); err != nil {
		return domain.Workbench{}, mapDB(err)
	}
	if err := r.pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM organizations
			WHERE owner_user_id = $1 AND dissolved_at IS NULL) AS has`, userID).Scan(&out.TransferAvailable); err != nil {
		return domain.Workbench{}, mapDB(err)
	}
	return out, nil
}

func (r *Repo) isAgent(ctx context.Context, userID int64) (bool, error) {
	var one int
	err := r.pool.QueryRow(ctx, `SELECT 1 FROM agents WHERE user_id = $1`, userID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, mapDB(err)
	}
	return true, nil
}

// Ledger is GET /api/agent/ledger. Non-agents are ErrNotAgent, not an empty list.
func (r *Repo) Ledger(ctx context.Context, userID int64) ([]domain.LedgerView, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	ok, err := r.isAgent(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, contract.ErrNotAgent
	}
	rows, err := r.pool.Query(ctx, ledgerSQL, userID, domain.LedgerWindow)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	out := []domain.LedgerView{}
	for rows.Next() {
		var e domain.LedgerView
		if err := rows.Scan(&e.EntryType, &e.AmountCents, &e.HeldDeltaCents, &e.BalanceAfterCents, &e.Note, &e.CreatedAt); err != nil {
			return nil, mapDB(err)
		}
		if domain.AgentLedgerVisible(e.EntryType) {
			out = append(out, e)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	return out, nil
}

// Withdrawals is GET /api/agent/withdrawals.
func (r *Repo) Withdrawals(ctx context.Context, userID int64) ([]domain.WithdrawalView, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	ok, err := r.isAgent(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, contract.ErrNotAgent
	}
	rows, err := r.pool.Query(ctx, withdrawalSQL, userID, domain.WithdrawalWindow)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	out := []domain.WithdrawalView{}
	for rows.Next() {
		v, err := scanWithdrawal(rows)
		if err != nil {
			return nil, mapDB(err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	return out, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanWithdrawal(row scanner) (domain.WithdrawalView, error) {
	var v domain.WithdrawalView
	err := row.Scan(&v.PublicID, &v.AmountCents, &v.Channel, &v.Account, &v.RealName,
		&v.Status, &v.Reference, &v.RejectReason, &v.RequestedAt, &v.DecidedAt)
	return v, err
}
