package supplierrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	supcontract "github.com/xxww0098/podhub-go/internal/admin/supplier/contract"
)

func (r Portal) ListWithdrawals(ctx context.Context, actor outcome.Actor, status string) ([]supcontract.Withdrawal, error) {
	var out []supcontract.Withdrawal
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		var filter any
		if status != "" {
			filter = status
		}
		rows, err := tx.Query(ctx, `
			SELECT w.withdrawal_id::text, w.source_id, s.name, w.amount_cents, w.channel, w.account,
			       w.real_name, w.status, w.reference, w.reject_reason, w.requested_at_ms, w.decided_at_ms
			  FROM supplier_withdrawals w
			  JOIN sc_sources s ON s.source_id = w.source_id
			 WHERE $1::text IS NULL OR w.status = $1
			 ORDER BY w.requested_at_ms DESC
			 LIMIT 100`, filter)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		out = []supcontract.Withdrawal{}
		for rows.Next() {
			row, err := scanWithdrawal(rows)
			if err != nil {
				return err
			}
			out = append(out, row)
		}
		return corerepo.MapDB(rows.Err())
	})
	return out, err
}

func (r Portal) PayWithdrawal(ctx context.Context, actor outcome.Actor, id, reference string, nowMs int64) (supcontract.Withdrawal, error) {
	return r.decide(ctx, actor, id, nowMs, "paid", reference, "", "withdrawal_paid", "supplier_withdrawal_paid")
}

func (r Portal) RejectWithdrawal(ctx context.Context, actor outcome.Actor, id, reason string, nowMs int64) (supcontract.Withdrawal, error) {
	return r.decide(ctx, actor, id, nowMs, "rejected", "", reason, "withdrawal_release", "supplier_withdrawal_rejected")
}

func (r Portal) decide(ctx context.Context, actor outcome.Actor, id string, nowMs int64, next, reference, reason, entry, action string) (supcontract.Withdrawal, error) {
	var out supcontract.Withdrawal
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if err := corerepo.AssertWrite(ctx, tx); err != nil {
			return err
		}
		var source string
		var amount int64
		var status string
		err := tx.QueryRow(ctx, `
			SELECT source_id, amount_microfen, status
			  FROM supplier_withdrawals
			 WHERE withdrawal_id = $1::uuid
			 FOR UPDATE`, id).Scan(&source, &amount, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return corerepo.NotFound("提现不存在")
		}
		if err != nil {
			return corerepo.MapDB(err)
		}
		if status != "requested" {
			return corerepo.Conflict("这笔提现已经处理过")
		}
		if next == "paid" {
			value, err := supcontract.Bounded(reference, 64, "打款单号须为 1–64 个字符")
			if err != nil {
				return err
			}
			reference = value
		} else {
			value, err := supcontract.Bounded(reason, 200, "驳回原因须为 1–200 个字符")
			if err != nil {
				return err
			}
			reason = value
		}
		balanceDelta, heldDelta, ledgerAmount := int64(0), int64(0), int64(0)
		if next == "paid" {
			balanceDelta, heldDelta, ledgerAmount = -amount, -amount, amount
		} else {
			heldDelta = -amount
		}
		if err := moveCash(ctx, tx, source, entry, "withdrawal:"+id, ledgerAmount, balanceDelta, heldDelta, nowMs); err != nil {
			return err
		}
		var ref any
		var why any
		if reference != "" {
			ref = reference
		}
		if reason != "" {
			why = reason
		}
		tag, err := tx.Exec(ctx, `
			UPDATE supplier_withdrawals
			   SET status = $2, reference = $3, reject_reason = $4, decided_at_ms = $5
			 WHERE withdrawal_id = $1::uuid AND status = 'requested'`, id, next, ref, why, nowMs)
		if err != nil {
			return corerepo.MapDB(err)
		}
		if tag.RowsAffected() != 1 {
			return corerepo.Conflict("这笔提现已经处理过")
		}
		row, err := loadWithdrawal(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := corerepo.Audit(ctx, tx, actor, "supplier_portal", "supplier_withdrawal", id, "POST",
			"/api/admin/supplier-withdrawals/{withdrawal_id}", action, corecontract.JSONText(struct {
				AmountCents int64  `json:"amountCents"`
				Channel     string `json:"channel"`
				Status      string `json:"status"`
			}{row.AmountCents, row.Channel, row.Status})); err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

func moveCash(ctx context.Context, tx pgx.Tx, source, entry, key string, amount, balanceDelta, heldDelta, nowMs int64) error {
	var balance, held int64
	err := tx.QueryRow(ctx, `
		SELECT balance_microfen, held_microfen FROM supplier_wallets
		 WHERE source_id = $1 FOR UPDATE`, source).Scan(&balance, &held)
	if errors.Is(err, pgx.ErrNoRows) {
		return corerepo.Conflict("可用余额不足")
	}
	if err != nil {
		return corerepo.MapDB(err)
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM supplier_wallet_ledger
		   WHERE source_id = $1 AND entry_type = $2 AND idempotency_key = $3)`, source, entry, key).Scan(&exists); err != nil {
		return corerepo.MapDB(err)
	}
	if exists {
		return nil
	}
	balanceAfter := balance + balanceDelta
	heldAfter := held + heldDelta
	if (balanceDelta > 0 && balanceAfter < balance) || (heldDelta > 0 && heldAfter < held) || (balanceDelta < 0 && balanceAfter > balance) || (heldDelta < 0 && heldAfter > held) {
		return corerepo.Conflict("结算金额超出范围")
	}
	if balanceAfter < 0 || heldAfter < 0 || heldAfter > balanceAfter {
		return corerepo.Conflict("可用余额不足")
	}
	tag, err := tx.Exec(ctx, `
		UPDATE supplier_wallets
		   SET balance_microfen = $2, held_microfen = $3, updated_at_ms = $4
		 WHERE source_id = $1`, source, balanceAfter, heldAfter, nowMs)
	if err != nil {
		return corerepo.MapDB(err)
	}
	if tag.RowsAffected() != 1 {
		return corerepo.Conflict("厂家钱包不可写")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO supplier_wallet_ledger (
		    source_id, entry_type, idempotency_key, amount_microfen,
		    held_delta_microfen, balance_after_microfen, held_after_microfen, created_at_ms)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		source, entry, key, amount, heldDelta, balanceAfter, heldAfter, nowMs)
	return corerepo.MapDB(err)
}

func loadWithdrawal(ctx context.Context, tx pgx.Tx, id string) (supcontract.Withdrawal, error) {
	rows, err := tx.Query(ctx, `
		SELECT w.withdrawal_id::text, w.source_id, s.name, w.amount_cents, w.channel, w.account,
		       w.real_name, w.status, w.reference, w.reject_reason, w.requested_at_ms, w.decided_at_ms
		  FROM supplier_withdrawals w
		  JOIN sc_sources s ON s.source_id = w.source_id
		 WHERE w.withdrawal_id = $1::uuid`, id)
	if err != nil {
		return supcontract.Withdrawal{}, corerepo.MapDB(err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return supcontract.Withdrawal{}, corerepo.MapDB(err)
		}
		return supcontract.Withdrawal{}, corerepo.NotFound("提现不存在")
	}
	return scanWithdrawal(rows)
}

func scanWithdrawal(rows pgx.Rows) (supcontract.Withdrawal, error) {
	var row supcontract.Withdrawal
	var reference, reason *string
	if err := rows.Scan(&row.WithdrawalID, &row.SourceID, &row.Name, &row.AmountCents, &row.Channel, &row.Account,
		&row.RealName, &row.Status, &reference, &reason, &row.RequestedAtMs, &row.DecidedAtMs); err != nil {
		return supcontract.Withdrawal{}, corerepo.MapDB(err)
	}
	if reference != nil {
		row.Reference = *reference
	}
	if reason != nil {
		row.RejectReason = *reason
	}
	return row, nil
}
