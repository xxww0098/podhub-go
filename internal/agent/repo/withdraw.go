package agentrepo

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// RequestWithdrawal freezes amount into held and inserts one pending row.
func (r *Repo) RequestWithdrawal(ctx context.Context, actor contract.Actor, amount int64) (domain.WithdrawalView, error) {
	var out domain.WithdrawalView
	err := r.write(ctx, func(tx pgx.Tx, sink *auditSink) error {
		if amount <= 0 {
			return contract.Fail(contract.KindValidation, "提现金额需为正数")
		}
		var status string
		var ch, ac, rn *string
		err := tx.QueryRow(ctx, `
			SELECT status, payout_channel, payout_account, payout_real_name
			FROM agents WHERE user_id = $1`, actor.UserID).Scan(&status, &ch, &ac, &rn)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Fail(contract.KindNotFound, "你不是代理")
		}
		if err != nil {
			return err
		}
		_ = status
		if ch == nil || ac == nil || rn == nil {
			return contract.Fail(contract.KindValidation, "请先填写收款信息")
		}
		var minWithdraw int64
		if err := tx.QueryRow(ctx, `
			SELECT min_withdraw_cents FROM agent_rebate_policy`).Scan(&minWithdraw); err != nil {
			return err
		}
		if amount < minWithdraw {
			return contract.Fail(contract.KindValidation, "未达最低提现金额")
		}
		bal, held, err := viewCommission(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		if domain.SaturatingSub(bal, held) < amount {
			return contract.Fail(contract.KindConflict, "可用余额不足")
		}
		var pending int64
		err = tx.QueryRow(ctx, `
			SELECT id FROM agent_withdrawals WHERE user_id = $1 AND status = 'pending'`, actor.UserID).Scan(&pending)
		if err == nil {
			return contract.Fail(contract.KindConflict, "已有在途提现")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		publicID, err := domain.WithdrawalPublicID(rand.Reader)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_withdrawals
			    (public_id, user_id, amount_cents, channel, account, real_name, status, requested_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'pending', clock_timestamp())`,
			publicID, actor.UserID, amount, *ch, *ac, *rn); err != nil {
			return err
		}
		var withdrawalID int64
		if err := tx.QueryRow(ctx, `SELECT id FROM agent_withdrawals WHERE public_id = $1`, publicID).Scan(&withdrawalID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("withdrawal insert returned no row")
			}
			return err
		}
		if err := hold(ctx, tx, actor.UserID, withdrawalID, "agent_withdrawal:"+publicID, amount); err != nil {
			return err
		}
		if err := sink.record(ctx, actor.OrgID, actor.UserID, "agent_withdrawal", publicID,
			"POST", "/api/agent/withdrawals", "agent_withdrawal_requested", withdrawalAudit{
				Summary:     "申请提现 " + publicID,
				AmountCents: amount,
			}); err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `
			SELECT w.public_id, w.amount_cents, w.channel, w.account, w.real_name,
			       w.status, w.reference, w.reject_reason,
			       to_char(w.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
			       to_char(w.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
			FROM agent_withdrawals w
			WHERE w.public_id = $1`, publicID).Scan(
			&out.PublicID, &out.AmountCents, &out.Channel, &out.Account, &out.RealName,
			&out.Status, &out.Reference, &out.RejectReason, &out.RequestedAt, &out.DecidedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("withdrawal missing after insert")
		}
		return err
	})
	return out, err
}
