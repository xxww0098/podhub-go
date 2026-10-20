package agentrepo

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// Claim binds an invite code inside the auth write gate.
// The normalized code is returned only through the agent's display name.
func (r *Repo) Claim(ctx context.Context, actor contract.Actor, raw string) (string, error) {
	var name string
	err := r.write(ctx, func(tx pgx.Tx, sink *auditSink) error {
		code, ok := domain.NormalizeInviteCode(raw)
		if !ok {
			return contract.Fail(contract.KindValidation, "邀请码无效")
		}
		var agentID, bps int64
		err := tx.QueryRow(ctx, `
			SELECT a.user_id, p.default_rebate_bps::bigint AS bps
			FROM agents a
			CROSS JOIN agent_rebate_policy p
			WHERE a.invite_code = $1 AND a.status = 'active'
			LIMIT 1`, code).Scan(&agentID, &bps)
		if errors.Is(err, pgx.ErrNoRows) || agentID == actor.UserID {
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			return contract.Fail(contract.KindValidation, "邀请码无效")
		}
		if err != nil {
			return err
		}
		var invited *int64
		var paid int64
		err = tx.QueryRow(ctx, `
			SELECT u.invited_by_agent_user_id,
			       a.name AS agent_name,
			       public.billing_owner_paid_orders(u.id) AS paid_orders
			FROM account_users u
			JOIN account_users a ON a.id = $2
			WHERE u.id = $1`, actor.UserID, agentID).Scan(&invited, &name, &paid)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Fail(contract.KindNotFound, "账号不存在")
		}
		if err != nil {
			return err
		}
		if invited != nil {
			return contract.Fail(contract.KindConflict, "已绑定邀请码")
		}
		if paid > 0 {
			return contract.Fail(contract.KindConflict, "已有订单，无法绑定")
		}
		if bps > math.MaxInt32 || bps < math.MinInt32 {
			return fmt.Errorf("rebate bps %d does not fit int32", bps)
		}
		tag, err := tx.Exec(ctx, `
			UPDATE account_users u
			   SET invited_by_agent_user_id = $2,
			       agent_attributed_at = clock_timestamp(),
			       agent_attribution_bps = $3,
			       agent_attribution_source = 'claim'
			 WHERE u.id = $1
			   AND u.invited_by_agent_user_id IS NULL
			   AND public.billing_owner_paid_orders(u.id) = 0`,
			actor.UserID, agentID, int32(bps))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return contract.Fail(contract.KindConflict, "已绑定邀请码")
		}
		var recent int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*)::bigint AS recent FROM account_users
			 WHERE invited_by_agent_user_id = $1
			   AND agent_attributed_at > clock_timestamp() - interval '24 hours'`, agentID).Scan(&recent); err != nil {
			return err
		}
		if recent > domain.ReviewThreshold {
			if _, err := tx.Exec(ctx, `UPDATE agents SET review_flagged_at = clock_timestamp() WHERE user_id = $1`, agentID); err != nil {
				return err
			}
		}
		return sink.record(ctx, actor.OrgID, actor.UserID, "agent_attribution", fmt.Sprint(actor.UserID),
			"POST", "/api/agent/claim", "agent_attribution_bound", claimAudit{
				Summary:             "绑定代理邀请码 " + code,
				AgentUserID:         agentID,
				AgentAttributionBps: bps,
			})
	})
	return name, err
}
