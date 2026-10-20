package agentrepo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

// Transfer moves commission cents into the oldest live owned workspace wallet.
func (r *Repo) Transfer(ctx context.Context, actor contract.Actor, operationID string, amount int64) (domain.Transfer, error) {
	var out domain.Transfer
	err := r.write(ctx, func(tx pgx.Tx, sink *auditSink) error {
		operationID = strings.TrimSpace(operationID)
		if operationID == "" {
			return contract.Fail(contract.KindValidation, "缺少 operation_id")
		}
		if amount <= 0 {
			return contract.Fail(contract.KindValidation, "转入金额需为正数")
		}
		if err := loadAgent(ctx, tx, actor.UserID); err != nil {
			return err
		}
		key := "agent_transfer:" + operationID
		var original *int64
		var stored int64
		err := tx.QueryRow(ctx, `
			SELECT amount_cents FROM agent_commission_ledger
			 WHERE user_id = $1 AND entry_type = 'transfer_out' AND idempotency_key = $2`,
			actor.UserID, key).Scan(&stored)
		if err == nil {
			original = &stored
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if original != nil {
			if abs(*original) != amount {
				return contract.Fail(contract.KindConflict, "operation_id 与已提交参数不一致")
			}
			orgID, uuid, name, ok, err := oldestOrg(ctx, tx, actor.UserID)
			if err != nil {
				return err
			}
			if !ok {
				return contract.Fail(contract.KindConflict, "没有可转入的工作空间")
			}
			bal, err := aiBalance(ctx, tx, orgID)
			if err != nil {
				return err
			}
			if err := sink.record(ctx, actor.OrgID, actor.UserID, "agent_transfer", operationID,
				"POST", "/api/agent/wallet-transfers", "agent_transfer_replayed", transferReplayAudit{
					Summary:     "佣金转入重放 " + operationID,
					AmountCents: amount,
				}); err != nil {
				return err
			}
			out = domain.Transfer{
				OperationID: operationID, AmountCents: amount,
				WalletBalanceMicrofen: bal, WorkspaceUUID: uuid, WorkspaceName: name,
			}
			return nil
		}
		orgID, uuid, name, ok, err := oldestOrg(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		if !ok {
			return contract.Fail(contract.KindConflict, "没有可转入的工作空间")
		}
		if err := transferOut(ctx, tx, actor.UserID, key, amount, "转入钱包 · "+operationID); err != nil {
			return err
		}
		micro, okMul := domain.Microfen(amount)
		if !okMul {
			return contract.Fail(contract.KindConflict, "转入金额超出可表示范围")
		}
		bal, err := adjust(ctx, tx, orgID, key, micro, "代理佣金转入")
		if err != nil {
			return err
		}
		if err := sink.record(ctx, actor.OrgID, actor.UserID, "agent_transfer", operationID,
			"POST", "/api/agent/wallet-transfers", "agent_transfer_completed", transferDoneAudit{
				Summary:     fmt.Sprintf("佣金余额转入钱包 %d 分", amount),
				AmountCents: amount,
				OrgID:       orgID,
			}); err != nil {
			return err
		}
		out = domain.Transfer{
			OperationID: operationID, AmountCents: amount,
			WalletBalanceMicrofen: bal, WorkspaceUUID: uuid, WorkspaceName: name,
		}
		return nil
	})
	return out, err
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func loadAgent(ctx context.Context, tx pgx.Tx, userID int64) error {
	var status string
	var ch, ac, rn *string
	err := tx.QueryRow(ctx, `
		SELECT status, payout_channel, payout_account, payout_real_name
		FROM agents WHERE user_id = $1`, userID).Scan(&status, &ch, &ac, &rn)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.Fail(contract.KindNotFound, "你不是代理")
	}
	return err
}
