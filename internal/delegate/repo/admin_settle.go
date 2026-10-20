package delegaterepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
)

func settleDispatch(ctx context.Context, tx pgx.Tx, dispatchID string, now int64) error {
	var orgID int64
	var source, state string
	var amount int64
	err := tx.QueryRow(ctx, `
		SELECT org_id, source_id, state, amount_microfen
		FROM delegate_settlements WHERE dispatch_id = $1::uuid FOR UPDATE`, dispatchID).Scan(&orgID, &source, &state, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		cents, micro, breakdown, err := quote(ctx, tx, dispatchID)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT org_id, source_id FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&orgID, &source); err != nil {
			return mapDB(err)
		}
		key := domain.SellerKey(dispatchID)
		if err := holdSeller(ctx, tx, orgID, key, micro); err != nil {
			return err
		}
		if err := settleSeller(ctx, tx, orgID, key, micro); err != nil {
			return err
		}
		if err := creditFactory(ctx, tx, source, key, micro, now); err != nil {
			return err
		}
		var inserted int64
		err = tx.QueryRow(ctx, `
			INSERT INTO delegate_settlements (
			    org_id, order_id, dispatch_id, source_id,
			    amount_cents, amount_microfen, state, breakdown, held_at_ms, settled_at_ms)
			SELECT org_id, order_id, dispatch_id, source_id, $2, $3, 'settled', $4::jsonb, $5, $5
			FROM delegate_dispatches WHERE dispatch_id = $1::uuid
			RETURNING org_id`, dispatchID, cents, micro, breakdown, now).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Conflict("结算没有写入")
		}
		return mapDB(err)
	}
	if err != nil {
		return mapDB(err)
	}
	switch state {
	case "settled":
		return nil
	case "released":
		return contract.Conflict("这笔冻结已退回，不能结算")
	case "held":
		key := domain.SellerKey(dispatchID)
		if err := settleSeller(ctx, tx, orgID, key, amount); err != nil {
			return err
		}
		if err := creditFactory(ctx, tx, source, key, amount, now); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE delegate_settlements SET state = 'settled', settled_at_ms = $2 WHERE dispatch_id = $1::uuid AND state = 'held'`, dispatchID, now)
		if err != nil {
			return mapDB(err)
		}
		if tag.RowsAffected() != 1 {
			return contract.Conflict("结算状态已变化")
		}
		return nil
	default:
		return contract.Conflict("结算状态异常")
	}
}

func quote(ctx context.Context, tx pgx.Tx, dispatchID string) (cents, micro int64, breakdown []byte, err error) {
	var found, lines, missing int64
	err = tx.QueryRow(ctx, `
WITH target AS (
    SELECT dispatch_id, source_id, payload FROM delegate_dispatches WHERE dispatch_id = $1::uuid
),
lines AS (
    SELECT t.source_id, COALESCE(l.offer_id, '') AS offer_id, GREATEST(COALESCE(l.quantity, 1), 1) AS quantity
    FROM target t
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(t.payload->'lines', '[]'::jsonb)) AS l(offer_id text, quantity int)
),
priced AS (
    SELECT lines.offer_id, lines.quantity,
           (SELECT COALESCE(o.cost_cents, 0) + COALESCE(o.shipping_cost_cents, 0)
            FROM sc_skus k
            JOIN sc_source_offers o ON o.sku_id = k.sku_id AND o.source_id = lines.source_id
            WHERE k.platform_code = lines.offer_id LIMIT 1) AS unit_cents
    FROM lines
)
SELECT (SELECT COUNT(*) FROM target)::bigint,
       (SELECT COUNT(*) FROM lines)::bigint,
       COALESCE((SELECT SUM(quantity * unit_cents) FROM priced WHERE unit_cents IS NOT NULL AND unit_cents > 0), 0)::bigint,
       (SELECT COUNT(*) FROM priced WHERE unit_cents IS NULL OR unit_cents <= 0)::bigint,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('offerId', offer_id, 'quantity', quantity, 'unitCents', unit_cents)) FROM priced), '[]'::jsonb)`,
		dispatchID).Scan(&found, &lines, &cents, &missing, &breakdown)
	if err != nil {
		return 0, 0, nil, mapDB(err)
	}
	if found == 0 {
		return 0, 0, nil, contract.NotFound("派发包不存在")
	}
	if lines == 0 || missing > 0 || cents <= 0 {
		return 0, 0, nil, contract.Conflict("有商品未标成本，无法结算")
	}
	micro, err = domain.Microfen(cents)
	return cents, micro, breakdown, err
}

func walletOwner(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	var userID int64
	if err := tx.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id = $1`, orgID).Scan(&userID); err != nil {
		return 0, mapDB(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true)`, itoa(userID)); err != nil {
		return 0, mapDB(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		return 0, mapDB(err)
	}
	return userID, nil
}

func lockWallet(ctx context.Context, tx pgx.Tx, orgID int64) (balance, held int64, err error) {
	userID, err := walletOwner(ctx, tx, orgID)
	if err != nil {
		return 0, 0, err
	}
	err = tx.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM user_wallets WHERE user_id = $1 FOR UPDATE`, userID).Scan(&balance, &held)
	if err != nil {
		return 0, 0, mapDB(err)
	}
	return balance, held, nil
}

type ledgerRow struct {
	amount, heldDelta, balAfter, heldAfter int64
	note                                   string
}

func existingLedger(ctx context.Context, tx pgx.Tx, orgID int64, key, entry string) (*ledgerRow, error) {
	var row ledgerRow
	err := tx.QueryRow(ctx, `
		SELECT amount_microfen, held_delta_microfen, balance_after_microfen, held_after_microfen, note
		FROM wallet_ledger WHERE org_id = $1 AND idempotency_key = $2 AND entry_type = $3 LIMIT 1`,
		orgID, key, entry).Scan(&row.amount, &row.heldDelta, &row.balAfter, &row.heldAfter, &row.note)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, mapDB(err)
	}
	return &row, nil
}

func holdSeller(ctx context.Context, tx pgx.Tx, orgID int64, key string, amount int64) error {
	if amount <= 0 || key == "" {
		return contract.Internal()
	}
	balance, held, err := lockWallet(ctx, tx, orgID)
	if err != nil {
		return err
	}
	if row, err := existingLedger(ctx, tx, orgID, key, "hold"); err != nil || row != nil {
		if err != nil {
			return err
		}
		if row.heldDelta != amount {
			return contract.Internal()
		}
		return nil
	}
	if balance-held < amount {
		return contract.Conflict("卖家余额不足，无法结算")
	}
	return applyLedger(ctx, tx, orgID, "hold", key, 0, amount, balance, held, balance, held+amount, "")
}

func settleSeller(ctx context.Context, tx pgx.Tx, orgID int64, key string, amount int64) error {
	if row, err := existingLedger(ctx, tx, orgID, key, "release"); err != nil || row != nil {
		if err != nil {
			return err
		}
		return contract.Conflict("这笔冻结已退回，不能结算")
	}
	balance, held, err := lockWallet(ctx, tx, orgID)
	if err != nil {
		return err
	}
	if row, err := existingLedger(ctx, tx, orgID, key, "settle"); err != nil || row != nil {
		if err != nil {
			return err
		}
		if row.amount != -amount || row.heldDelta != -amount {
			return contract.Internal()
		}
		return nil
	}
	hold, err := existingLedger(ctx, tx, orgID, key, "hold")
	if err != nil {
		return err
	}
	if hold == nil || hold.heldDelta != amount {
		return contract.Internal()
	}
	return applyLedger(ctx, tx, orgID, "settle", key, -amount, -amount, balance, held, balance-amount, held-amount, "")
}

func applyLedger(ctx context.Context, tx pgx.Tx, orgID int64, entry, key string, amount, heldDelta, balBefore, heldBefore, balAfter, heldAfter int64, note string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE user_wallets SET balance_microfen = $2, held_microfen = $3, version = version + 1, updated_at = clock_timestamp()
		WHERE user_id = (SELECT owner_user_id FROM organizations WHERE id = $1)`, orgID, balAfter, heldAfter)
	if err != nil {
		return mapDB(err)
	}
	if tag.RowsAffected() != 1 {
		return contract.Internal()
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO wallet_ledger
		    (org_id, user_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
		     balance_before_microfen, balance_after_microfen, held_before_microfen, held_after_microfen,
		     ai_request_id, payment_order_id, note)
		VALUES ($1, (SELECT owner_user_id FROM organizations WHERE id = $1),
		        $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10)`,
		orgID, entry, key, amount, heldDelta, balBefore, balAfter, heldBefore, heldAfter, note)
	return mapDB(err)
}

func creditFactory(ctx context.Context, tx pgx.Tx, source, key string, amount, now int64) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ($1, 0, 0, $2) ON CONFLICT (source_id) DO NOTHING`, source, now); err != nil {
		return mapWallet(err)
	}
	var balance, held int64
	if err := tx.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM supplier_wallets WHERE source_id = $1 FOR UPDATE`, source).Scan(&balance, &held); err != nil {
		return mapWallet(err)
	}
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM supplier_wallet_ledger WHERE source_id = $1 AND entry_type = 'credit' AND idempotency_key = $2`, source, key).Scan(&one)
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return mapWallet(err)
	}
	after := balance + amount
	if after < 0 || held < 0 || held > after {
		return contract.Conflict("卖家余额不足，无法结算")
	}
	tag, err := tx.Exec(ctx, `UPDATE supplier_wallets SET balance_microfen = $2, held_microfen = $3, updated_at_ms = $4 WHERE source_id = $1`, source, after, held, now)
	if err != nil {
		return mapWallet(err)
	}
	if tag.RowsAffected() != 1 {
		return contract.Conflict("厂家钱包不可写")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO supplier_wallet_ledger (
		    source_id, entry_type, idempotency_key, amount_microfen,
		    held_delta_microfen, balance_after_microfen, held_after_microfen, created_at_ms)
		VALUES ($1, 'credit', $2, $3, 0, $4, $5, $6)`, source, key, amount, after, held, now)
	return mapWallet(err)
}
