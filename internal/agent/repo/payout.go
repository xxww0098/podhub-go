package agentrepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// SavePayout updates the three payout columns, or clears them.
// cleared is true when the stored account is all NULL. The returned payout
// is the normalized value that was written.
func (r *Repo) SavePayout(ctx context.Context, actor contract.Actor, channel, account, realName *string) (domain.Payout, bool, error) {
	var saved domain.Payout
	var cleared bool
	err := r.write(ctx, func(tx pgx.Tx, sink *auditSink) error {
		p, clear, msg := domain.NormalizePayout(channel, account, realName)
		if msg != "" {
			return contract.Fail(contract.KindValidation, msg)
		}
		var status string
		var curCh, curAc, curName *string
		err := tx.QueryRow(ctx, `
			SELECT status, payout_channel, payout_account, payout_real_name
			FROM agents WHERE user_id = $1`, actor.UserID).Scan(&status, &curCh, &curAc, &curName)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Fail(contract.KindNotFound, "你不是代理")
		}
		if err != nil {
			return err
		}
		_ = status
		var ch, ac, rn *string
		summary := "清除收款方式"
		if !clear {
			ch, ac, rn = &p.Channel, &p.Account, &p.RealName
			summary = "保存收款方式"
			saved = p
		} else {
			cleared = true
		}
		tag, err := tx.Exec(ctx, `
			UPDATE agents
			   SET payout_channel = $2, payout_account = $3, payout_real_name = $4,
			       updated_at = clock_timestamp()
			 WHERE user_id = $1`, actor.UserID, ch, ac, rn)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("payout update affected %d rows", tag.RowsAffected())
		}
		return sink.record(ctx, actor.OrgID, actor.UserID, "agent_payout_account", fmt.Sprint(actor.UserID),
			"PUT", "/api/agent/payout-account", "agent_payout_account_saved", payoutAudit{
				Summary: summary,
				Channel: ch,
			})
	})
	return saved, cleared, err
}
