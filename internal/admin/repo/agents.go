package adminrepo

import (
	"context"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// AgentsRepo stores admin agent rows. These tables have no RLS.
type AgentsRepo struct {
	Pool *pgxpool.Pool
}

func (r AgentsRepo) read(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := BeginAdmin(ctx, r.Pool)
	if err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	if err := fn(tx); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	return mapAdmin(tx.Commit(ctx), "INTERNAL")
}

func (r AgentsRepo) write(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := BeginAdmin(ctx, r.Pool)
	if err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	defer writer.Forget(tx)
	if err := AssertWriteLease(ctx, tx, "管理域写入未启用"); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	return mapAdmin(tx.Commit(ctx), "INTERNAL")
}

func (r AgentsRepo) ListCommissions(ctx context.Context, status *string, limit, offset int64) (int64, []domain.Commission, error) {
	var total int64
	var rowsOut []domain.Commission
	err := r.read(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT count(*)::bigint FROM agent_commissions c WHERE ($1::text IS NULL OR c.status = $1)`, status).Scan(&total); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		rows, err := tx.Query(ctx, `SELECT c.id, agent.email, invitee.email, COALESCE(paying.name, ''),
			o.public_id, o.product, c.order_amount_cents, c.rebate_bps::bigint, c.amount_cents, c.status, c.note,
			to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			FROM agent_commissions c
			JOIN account_users agent ON agent.id = c.agent_user_id
			JOIN account_users invitee ON invitee.id = c.invitee_user_id
			JOIN LATERAL public.billing_payment_order_brief(c.payment_order_id) o ON true
			LEFT JOIN organizations paying ON paying.id = c.org_id
			WHERE ($1::text IS NULL OR c.status = $1)
			ORDER BY c.created_at DESC, c.id DESC
			LIMIT $2 OFFSET $3`, status, limit, offset)
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		defer rows.Close()
		for rows.Next() {
			var row domain.Commission
			if err := rows.Scan(&row.ID, &row.AgentEmail, &row.InviteeEmail, &row.WorkspaceName, &row.PaymentOrderPublicID,
				&row.Product, &row.OrderAmountCents, &row.RebateBps, &row.AmountCents, &row.Status, &row.Note, &row.CreatedAt); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			rowsOut = append(rowsOut, row)
		}
		return mapAdmin(rows.Err(), "INTERNAL")
	})
	return total, rowsOut, err
}

func (r AgentsRepo) SetPolicy(ctx context.Context, actor domain.Actor, in domain.PolicyInput) error {
	return r.write(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE agent_rebate_policy
			SET default_rebate_bps = $1, min_order_cents = $2, attribution_validity_days = $3,
			    min_withdraw_cents = $4, updated_by_user_id = $5, updated_at = clock_timestamp()`,
			int32(in.DefaultRebateBps), in.MinOrderCents, int32(in.AttributionValidityDays), in.MinWithdrawCents, actor.UserID); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		msg, _ := domain.Marshal(struct {
			Summary                 string `json:"summary"`
			DefaultRebateBps        int64  `json:"default_rebate_bps"`
			MinOrderCents           int64  `json:"min_order_cents"`
			AttributionValidityDays int64  `json:"attribution_validity_days"`
			MinWithdrawCents        int64  `json:"min_withdraw_cents"`
		}{domain.PolicySummary(in), in.DefaultRebateBps, in.MinOrderCents, in.AttributionValidityDays, in.MinWithdrawCents})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "agents", EntityType: "agent_rebate_policy",
			EntityID: "*", Method: "PUT", Path: "/api/admin/agent-rebate-policy",
			Action: "agent_rebate_policy_updated", Message: string(msg),
		})
	})
}

func (r AgentsRepo) ListWithdrawals(ctx context.Context, status *string) ([]domain.AgentWithdrawal, error) {
	var out []domain.AgentWithdrawal
	err := r.read(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT w.public_id, u.email, w.amount_cents, w.channel, w.account, w.real_name,
			w.status, w.reference, w.reject_reason,
			to_char(w.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			to_char(w.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			FROM agent_withdrawals w
			JOIN account_users u ON u.id = w.user_id
			WHERE ($1::text IS NULL OR w.status = $1)
			ORDER BY (w.status = 'pending') DESC, w.requested_at DESC, w.id DESC
			LIMIT 500`, status)
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		defer rows.Close()
		for rows.Next() {
			row, err := scanAgentWithdrawal(rows)
			if err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			out = append(out, row)
		}
		return mapAdmin(rows.Err(), "INTERNAL")
	})
	return out, err
}

func (r AgentsRepo) Pay(ctx context.Context, actor domain.Actor, publicID string, reference *string) (domain.AgentWithdrawal, error) {
	return r.decide(ctx, actor, publicID, true, reference, "")
}

func (r AgentsRepo) Reject(ctx context.Context, actor domain.Actor, publicID, reason string) (domain.AgentWithdrawal, error) {
	return r.decide(ctx, actor, publicID, false, nil, reason)
}

func (r AgentsRepo) decide(ctx context.Context, actor domain.Actor, publicID string, pay bool, reference *string, reason string) (domain.AgentWithdrawal, error) {
	var out domain.AgentWithdrawal
	err := r.write(ctx, func(tx pgx.Tx) error {
		var id, userID, amount int64
		var status string
		err := tx.QueryRow(ctx, `SELECT id, user_id, amount_cents, status FROM agent_withdrawals WHERE public_id = $1 FOR UPDATE`, publicID).
			Scan(&id, &userID, &amount, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Fail(404, "NOT_FOUND", "提现单不存在")
		}
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		if status != "pending" {
			return domain.Fail(409, "CONFLICT", "提现单已处理")
		}
		if pay {
			if _, err := tx.Exec(ctx, `UPDATE agent_withdrawals SET status = 'paid', reference = $2, decided_at = clock_timestamp(), decided_by_user_id = $3 WHERE id = $1 AND status = 'pending'`, id, reference, actor.UserID); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if err := settlePaid(ctx, tx, userID, id, publicID, amount); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE agent_withdrawals SET status = 'rejected', reject_reason = $2, decided_at = clock_timestamp(), decided_by_user_id = $3 WHERE id = $1 AND status = 'pending'`, id, reason, actor.UserID); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if err := releaseHold(ctx, tx, userID, id, publicID, amount); err != nil {
				return err
			}
		}
		row, err := loadAgentWithdrawal(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if row == nil {
			return domain.Fail(500, "INTERNAL", "服务暂不可用")
		}
		out = *row
		action := "agent_withdrawal_rejected"
		path := "/api/admin/agent-withdrawals/{public_id}/reject"
		kind := "agent_withdrawal_rejected"
		summary := "提现单 " + publicID + " 已拒绝"
		if pay {
			action = "agent_withdrawal_paid"
			path = "/api/admin/agent-withdrawals/{public_id}/pay"
			kind = "agent_withdrawal_paid"
			summary = "提现单 " + publicID + " 已打款"
		}
		var payload any
		if pay {
			payload = struct {
				Summary     string  `json:"summary"`
				AgentUserID int64   `json:"agent_user_id"`
				AmountCents int64   `json:"amount_cents"`
				Reference   *string `json:"reference"`
			}{summary, userID, amount, reference}
		} else {
			payload = struct {
				Summary      string `json:"summary"`
				AgentUserID  int64  `json:"agent_user_id"`
				AmountCents  int64  `json:"amount_cents"`
				RejectReason string `json:"reject_reason"`
			}{summary, userID, amount, reason}
		}
		msg, _ := domain.Marshal(payload)
		if err := InsertAudit(ctx, tx, domain.Audit{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "agents", EntityType: "agent_withdrawal",
			EntityID: publicID, Method: "POST", Path: path, Action: action, Message: string(msg),
		}); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		var rejectReason *string
		if !pay {
			rejectReason = &reason
		}
		body, err := domain.Marshal(struct {
			AmountCents  int64   `json:"amountCents"`
			PublicID     string  `json:"publicId"`
			RejectReason *string `json:"rejectReason"`
		}{amount, publicID, rejectReason})
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO notifications (uuid, user_id, kind, payload, created_at) VALUES (gen_random_uuid(), $1, $2, $3::jsonb, clock_timestamp())`, userID, kind, body)
		return mapAdmin(err, "INTERNAL")
	})
	return out, err
}

func (r AgentsRepo) ListAgents(ctx context.Context, actor domain.Actor, query, status *string, flagged bool) (domain.Policy, []domain.Agent, error) {
	var policy domain.Policy
	var rowsOut []domain.Agent
	err := r.read(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT default_rebate_bps::bigint, min_order_cents, attribution_validity_days::bigint, min_withdraw_cents FROM agent_rebate_policy`).
			Scan(&policy.DefaultRebateBps, &policy.MinOrderCents, &policy.AttributionValidityDays, &policy.MinWithdrawCents)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Fail(500, "INTERNAL", "服务暂不可用")
		}
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		rows, err := tx.Query(ctx, agentProjection+`
			WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%' OR a.invite_code ILIKE '%' || $1 || '%')
			  AND ($2::text IS NULL OR a.status = $2)
			  AND (NOT $3::boolean OR a.review_flagged_at IS NOT NULL)
			ORDER BY a.created_at DESC, a.user_id DESC`, query, status, flagged)
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		defer rows.Close()
		for rows.Next() {
			row, err := scanAgent(rows)
			if err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			rowsOut = append(rowsOut, row)
		}
		if err := rows.Err(); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		msg, _ := domain.Marshal(struct {
			Summary string `json:"summary"`
			Count   int    `json:"count"`
		}{"列出代理 " + strconv.Itoa(len(rowsOut)) + " 个", len(rowsOut)})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "agents", EntityType: "agent",
			EntityID: "*", Method: "GET", Path: "/api/admin/agents", Action: "agents_listed", Message: string(msg),
		})
	})
	return policy, rowsOut, err
}

func (r AgentsRepo) CreateAgent(ctx context.Context, actor domain.Actor, email string, invite *string, generated string) (domain.Agent, error) {
	var out domain.Agent
	err := r.write(ctx, func(tx pgx.Tx) error {
		var userID int64
		err := tx.QueryRow(ctx, `SELECT id FROM account_users WHERE lower(email) = $1 AND disabled_at IS NULL LIMIT 1`, email).Scan(&userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Fail(404, "NOT_FOUND", "账号不存在或已停用")
		}
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		var exists int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM agents WHERE user_id = $1`, userID).Scan(&exists); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		if exists > 0 {
			return domain.Fail(409, "CONFLICT", "该账号已是代理")
		}
		code := generated
		if invite != nil {
			code = *invite
		}
		var taken int64
		err = tx.QueryRow(ctx, `SELECT user_id FROM agents WHERE invite_code = $1`, code).Scan(&taken)
		if err == nil {
			if invite == nil {
				return domain.Fail(409, "CONFLICT", "邀请码生成冲突，请重试")
			}
			return domain.Fail(409, "CONFLICT", "邀请码已被其他代理使用")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return mapAdmin(err, "INTERNAL")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agents (user_id, invite_code, status, created_by_user_id) VALUES ($1, $2, 'active', $3)`, userID, code, actor.UserID); err != nil {
			return inviteConflict(err, invite == nil)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_commission_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		row, err := loadAgent(ctx, tx, userID)
		if err != nil {
			return err
		}
		if row == nil {
			return domain.Fail(500, "INTERNAL", "服务暂不可用")
		}
		out = *row
		msg, _ := domain.Marshal(struct {
			Summary    string `json:"summary"`
			Email      string `json:"email"`
			InviteCode string `json:"invite_code"`
		}{"开通代理 " + email, email, code})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "agents", EntityType: "agent",
			EntityID: strconv.FormatInt(userID, 10), Method: "POST", Path: "/api/admin/agents",
			Action: "agent_enabled", Message: string(msg),
		})
	})
	return out, err
}

func (r AgentsRepo) UpdateAgent(ctx context.Context, actor domain.Actor, uuid, status string, invite *string, keep bool) (domain.Agent, error) {
	var out domain.Agent
	err := r.write(ctx, func(tx pgx.Tx) error {
		var userID int64
		err := tx.QueryRow(ctx, `SELECT a.user_id FROM agents a JOIN account_users u ON u.id = a.user_id WHERE u.uuid = lower($1)::uuid`, uuid).Scan(&userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Fail(404, "NOT_FOUND", "代理不存在")
		}
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		code := ""
		if keep {
			if err := tx.QueryRow(ctx, `SELECT invite_code FROM agents WHERE user_id = $1`, userID).Scan(&code); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
		} else if invite != nil {
			code = *invite
			var owner int64
			err := tx.QueryRow(ctx, `SELECT user_id FROM agents WHERE invite_code = $1`, code).Scan(&owner)
			if err == nil && owner != userID {
				return domain.Fail(409, "CONFLICT", "邀请码已被其他代理使用")
			}
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return mapAdmin(err, "INTERNAL")
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE agents SET invite_code = $2, status = $3, updated_at = clock_timestamp() WHERE user_id = $1`, userID, code, status); err != nil {
			return inviteConflict(err, false)
		}
		row, err := loadAgent(ctx, tx, userID)
		if err != nil {
			return err
		}
		if row == nil {
			return domain.Fail(404, "NOT_FOUND", "代理不存在")
		}
		out = *row
		msg, _ := domain.Marshal(struct {
			Summary    string `json:"summary"`
			InviteCode string `json:"invite_code"`
			Status     string `json:"status"`
		}{"更新代理 " + strconv.FormatInt(userID, 10), code, status})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: actor.OrgID, UserID: actor.UserID, Module: "agents", EntityType: "agent",
			EntityID: strconv.FormatInt(userID, 10), Method: "PUT", Path: "/api/admin/agents/{uuid}",
			Action: "agent_updated", Message: string(msg),
		})
	})
	return out, err
}

const agentProjection = `
SELECT lower(u.uuid::text), u.email, u.name, a.invite_code, a.status,
       a.payout_channel, a.payout_account, a.payout_real_name,
       COALESCE(w.balance_cents, 0)::bigint, COALESCE(w.held_cents, 0)::bigint,
       (SELECT count(*) FROM account_users i WHERE i.invited_by_agent_user_id = a.user_id)::bigint,
       (SELECT count(*) FROM agent_commissions c WHERE c.agent_user_id = a.user_id AND c.status = 'credited')::bigint,
       (SELECT count(*) FROM agent_commissions c WHERE c.agent_user_id = a.user_id AND c.status = 'skipped')::bigint,
       COALESCE((SELECT sum(c.amount_cents) FROM agent_commissions c WHERE c.agent_user_id = a.user_id AND c.status = 'credited'), 0)::bigint,
       to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(a.review_flagged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM agents a
JOIN account_users u ON u.id = a.user_id
LEFT JOIN agent_commission_wallets w ON w.user_id = a.user_id
`

func loadAgent(ctx context.Context, tx pgx.Tx, userID int64) (*domain.Agent, error) {
	rows, err := tx.Query(ctx, agentProjection+` WHERE a.user_id = $1`, userID)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	row, err := scanAgent(rows)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	return &row, nil
}

func scanAgent(row pgx.Row) (domain.Agent, error) {
	var a domain.Agent
	var channel, account, name *string
	var flagged *string
	if err := row.Scan(&a.UserUUID, &a.Email, &a.Name, &a.InviteCode, &a.Status, &channel, &account, &name,
		&a.WalletBalanceCents, &a.WalletHeldCents, &a.InviteeCount, &a.CreditedCount, &a.SkippedCount, &a.CreditedTotalCents,
		&a.CreatedAt, &flagged); err != nil {
		return domain.Agent{}, err
	}
	if channel != nil && account != nil && name != nil {
		a.PayoutAccount = &domain.PayoutAccount{Channel: *channel, Account: *account, RealName: *name}
	}
	a.ReviewFlaggedAt = flagged
	return a, nil
}

func loadAgentWithdrawal(ctx context.Context, tx pgx.Tx, publicID string) (*domain.AgentWithdrawal, error) {
	rows, err := tx.Query(ctx, `SELECT w.public_id, u.email, w.amount_cents, w.channel, w.account, w.real_name,
		w.status, w.reference, w.reject_reason,
		to_char(w.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		to_char(w.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		FROM agent_withdrawals w JOIN account_users u ON u.id = w.user_id WHERE w.public_id = $1`, publicID)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	row, err := scanAgentWithdrawal(rows)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	return &row, nil
}

func scanAgentWithdrawal(row pgx.Row) (domain.AgentWithdrawal, error) {
	var w domain.AgentWithdrawal
	if err := row.Scan(&w.PublicID, &w.AgentEmail, &w.AmountCents, &w.Channel, &w.Account, &w.RealName,
		&w.Status, &w.Reference, &w.RejectReason, &w.RequestedAt, &w.DecidedAt); err != nil {
		return domain.AgentWithdrawal{}, err
	}
	if w.Reference != nil && *w.Reference == "" {
		w.Reference = nil
	}
	if w.RejectReason != nil && *w.RejectReason == "" {
		w.RejectReason = nil
	}
	if w.DecidedAt != nil && *w.DecidedAt == "" {
		w.DecidedAt = nil
	}
	return w, nil
}

func settlePaid(ctx context.Context, tx pgx.Tx, userID, withdrawalID int64, publicID string, amount int64) error {
	key := "agent_withdrawal:" + publicID
	if _, err := tx.Exec(ctx, `INSERT INTO agent_commission_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	var bal, held int64
	if err := tx.QueryRow(ctx, `SELECT balance_cents, held_cents FROM agent_commission_wallets WHERE user_id = $1 FOR UPDATE`, userID).Scan(&bal, &held); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	hold, err := ledger(ctx, tx, userID, "withdrawal_hold", key)
	if err != nil {
		return err
	}
	if hold == nil || hold.held != amount || hold.withdrawal == nil || *hold.withdrawal != withdrawalID {
		return domain.Fail(409, "CONFLICT", "wallet is missing the reservation being decided")
	}
	released, err := ledger(ctx, tx, userID, "withdrawal_release", key)
	if err != nil {
		return err
	}
	if released != nil {
		return domain.Fail(409, "CONFLICT", "a released withdrawal cannot be paid")
	}
	paid, err := ledger(ctx, tx, userID, "withdrawal_paid", key)
	if err != nil {
		return err
	}
	if paid != nil {
		if paid.amount == -amount && paid.withdrawal != nil && *paid.withdrawal == withdrawalID {
			return nil
		}
		return domain.Fail(409, "CONFLICT", "payment parameters differ from the original settlement")
	}
	if held < amount {
		return domain.Fail(409, "CONFLICT", "wallet is missing the reservation being settled")
	}
	afterBal, afterHeld := bal-amount, held-amount
	if _, err := tx.Exec(ctx, `UPDATE agent_commission_wallets SET balance_cents = $2, held_cents = $3, version = version + 1, updated_at = clock_timestamp() WHERE user_id = $1`, userID, afterBal, afterHeld); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_commission_ledger
		(user_id, entry_type, idempotency_key, amount_cents, held_delta_cents, balance_before_cents, balance_after_cents, held_before_cents, held_after_cents, withdrawal_id, note)
		VALUES ($1, 'withdrawal_paid', $2, $3, $4, $5, $6, $7, $8, $9, '')`,
		userID, key, -amount, -amount, bal, afterBal, held, afterHeld, withdrawalID)
	return mapAdmin(err, "INTERNAL")
}

func releaseHold(ctx context.Context, tx pgx.Tx, userID, withdrawalID int64, publicID string, amount int64) error {
	key := "agent_withdrawal:" + publicID
	if _, err := tx.Exec(ctx, `INSERT INTO agent_commission_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	var bal, held int64
	if err := tx.QueryRow(ctx, `SELECT balance_cents, held_cents FROM agent_commission_wallets WHERE user_id = $1 FOR UPDATE`, userID).Scan(&bal, &held); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	paid, err := ledger(ctx, tx, userID, "withdrawal_paid", key)
	if err != nil {
		return err
	}
	if paid != nil {
		return domain.Fail(409, "CONFLICT", "a paid withdrawal cannot be released")
	}
	prior, err := ledger(ctx, tx, userID, "withdrawal_release", key)
	if err != nil {
		return err
	}
	if prior != nil {
		if prior.amount == 0 && prior.held == -amount && prior.withdrawal != nil && *prior.withdrawal == withdrawalID {
			return nil
		}
		return domain.Fail(409, "CONFLICT", "payment parameters differ from the original settlement")
	}
	hold, err := ledger(ctx, tx, userID, "withdrawal_hold", key)
	if err != nil {
		return err
	}
	if hold == nil || hold.held != amount || hold.withdrawal == nil || *hold.withdrawal != withdrawalID {
		return domain.Fail(409, "CONFLICT", "wallet is missing the reservation being decided")
	}
	if held < amount {
		return domain.Fail(409, "CONFLICT", "wallet is missing the reservation being settled")
	}
	afterHeld := held - amount
	if _, err := tx.Exec(ctx, `UPDATE agent_commission_wallets SET held_cents = $2, version = version + 1, updated_at = clock_timestamp() WHERE user_id = $1`, userID, afterHeld); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_commission_ledger
		(user_id, entry_type, idempotency_key, amount_cents, held_delta_cents, balance_before_cents, balance_after_cents, held_before_cents, held_after_cents, withdrawal_id, note)
		VALUES ($1, 'withdrawal_release', $2, 0, $3, $4, $4, $5, $6, $7, '')`,
		userID, key, -amount, bal, held, afterHeld, withdrawalID)
	return mapAdmin(err, "INTERNAL")
}

type led struct {
	amount, held int64
	withdrawal   *int64
}

func ledger(ctx context.Context, tx pgx.Tx, userID int64, entry, key string) (*led, error) {
	var row led
	err := tx.QueryRow(ctx, `SELECT amount_cents, held_delta_cents, withdrawal_id FROM agent_commission_ledger WHERE user_id = $1 AND entry_type = $2 AND idempotency_key = $3`, userID, entry, key).
		Scan(&row.amount, &row.held, &row.withdrawal)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	return &row, nil
}

func inviteConflict(err error, generated bool) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		if generated {
			return domain.Fail(409, "CONFLICT", "邀请码生成冲突，请重试")
		}
		return domain.Fail(409, "CONFLICT", "邀请码已被其他代理使用")
	}
	return mapAdmin(err, "INTERNAL")
}
