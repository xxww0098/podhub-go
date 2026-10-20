package agentrepo

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
)

func validateAmount(key string, amount int64) error {
	if strings.TrimSpace(key) == "" {
		return contract.Fail(contract.KindConflict, "a commission movement requires an idempotency key")
	}
	if amount <= 0 {
		return contract.Fail(contract.KindConflict, "a commission movement requires a positive amount")
	}
	return nil
}

func ensureCommission(ctx context.Context, tx pgx.Tx, userID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO agent_commission_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID)
	return err
}

func lockCommission(ctx context.Context, tx pgx.Tx, userID int64) (int64, int64, error) {
	if err := ensureCommission(ctx, tx, userID); err != nil {
		return 0, 0, err
	}
	var bal, held int64
	err := tx.QueryRow(ctx, `
		SELECT balance_cents, held_cents
		FROM agent_commission_wallets WHERE user_id = $1 FOR UPDATE`, userID).Scan(&bal, &held)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, fmt.Errorf("commission wallet vanished after upsert")
	}
	return bal, held, err
}

func viewCommission(ctx context.Context, tx pgx.Tx, userID int64) (int64, int64, error) {
	if err := ensureCommission(ctx, tx, userID); err != nil {
		return 0, 0, err
	}
	var bal, held int64
	err := tx.QueryRow(ctx, `
		SELECT balance_cents, held_cents
		FROM agent_commission_wallets WHERE user_id = $1`, userID).Scan(&bal, &held)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, fmt.Errorf("commission wallet vanished after upsert")
	}
	return bal, held, err
}

func applyCommission(ctx context.Context, tx pgx.Tx, userID, bal, held int64) error {
	tag, err := tx.Exec(ctx, `
		UPDATE agent_commission_wallets
		   SET balance_cents = $2,
		       held_cents = $3,
		       version = version + 1,
		       updated_at = clock_timestamp()
		 WHERE user_id = $1`, userID, bal, held)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("commission wallet update affected %d rows for user %d", tag.RowsAffected(), userID)
	}
	return nil
}

func recordCommission(ctx context.Context, tx pgx.Tx, userID int64, entryType, key string, amount, heldDelta, beforeBal, afterBal, beforeHeld, afterHeld int64, commissionID, withdrawalID *int64, note string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO agent_commission_ledger
		    (user_id, entry_type, idempotency_key, amount_cents, held_delta_cents,
		     balance_before_cents, balance_after_cents,
		     held_before_cents, held_after_cents,
		     commission_id, withdrawal_id, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		userID, entryType, key, amount, heldDelta, beforeBal, afterBal, beforeHeld, afterHeld, commissionID, withdrawalID, note)
	return err
}

type movement struct {
	amount     int64
	heldDelta  int64
	balance    int64
	held       int64
	withdrawal *int64
	ok         bool
}

func existingMovement(ctx context.Context, tx pgx.Tx, userID int64, entryType, key string) (movement, error) {
	var m movement
	err := tx.QueryRow(ctx, `
		SELECT amount_cents, held_delta_cents, balance_after_cents, held_after_cents, withdrawal_id
		FROM agent_commission_ledger
		WHERE user_id = $1 AND entry_type = $2 AND idempotency_key = $3`,
		userID, entryType, key).Scan(&m.amount, &m.heldDelta, &m.balance, &m.held, &m.withdrawal)
	if errors.Is(err, pgx.ErrNoRows) {
		return movement{}, nil
	}
	if err != nil {
		return movement{}, err
	}
	m.ok = true
	return m, nil
}

func transferOut(ctx context.Context, tx pgx.Tx, userID int64, key string, amount int64, note string) error {
	if err := validateAmount(key, amount); err != nil {
		return err
	}
	beforeBal, beforeHeld, err := lockCommission(ctx, tx, userID)
	if err != nil {
		return err
	}
	prior, err := existingMovement(ctx, tx, userID, "transfer_out", key)
	if err != nil {
		return err
	}
	if prior.ok {
		if prior.amount == -amount {
			return nil
		}
		return contract.Fail(contract.KindConflict, "transfer parameters differ from the original transfer")
	}
	if domain.SaturatingSub(beforeBal, beforeHeld) < amount {
		return contract.Fail(contract.KindConflict, "可用余额不足")
	}
	afterBal := beforeBal - amount
	if err := applyCommission(ctx, tx, userID, afterBal, beforeHeld); err != nil {
		return err
	}
	return recordCommission(ctx, tx, userID, "transfer_out", key, -amount, 0, beforeBal, afterBal, beforeHeld, beforeHeld, nil, nil, note)
}

func hold(ctx context.Context, tx pgx.Tx, userID, withdrawalID int64, key string, amount int64) error {
	if err := validateAmount(key, amount); err != nil {
		return err
	}
	beforeBal, beforeHeld, err := lockCommission(ctx, tx, userID)
	if err != nil {
		return err
	}
	prior, err := existingMovement(ctx, tx, userID, "withdrawal_hold", key)
	if err != nil {
		return err
	}
	if prior.ok {
		if prior.heldDelta == amount && prior.withdrawal != nil && *prior.withdrawal == withdrawalID {
			return nil
		}
		return contract.Fail(contract.KindConflict, "hold parameters differ from the original reservation")
	}
	if domain.SaturatingSub(beforeBal, beforeHeld) < amount {
		return contract.Fail(contract.KindConflict, "可用余额不足")
	}
	if beforeHeld > math.MaxInt64-amount {
		return contract.Fail(contract.KindConflict, "commission wallet held overflow")
	}
	afterHeld := beforeHeld + amount
	if err := applyCommission(ctx, tx, userID, beforeBal, afterHeld); err != nil {
		return err
	}
	return recordCommission(ctx, tx, userID, "withdrawal_hold", key, 0, amount, beforeBal, beforeBal, beforeHeld, afterHeld, nil, &withdrawalID, "")
}

func withAppWallet(ctx context.Context, tx pgx.Tx, orgID, owner int64, fn func() error) error {
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.current_org_id', $1, true), set_config('app.current_wallet_user_id', $2, true)`,
		strconv.FormatInt(orgID, 10), strconv.FormatInt(owner, 10)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return err
	}
	return fn()
}

func walletOwner(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id = $1`, orgID).Scan(&id)
	return id, err
}

// aiBalance is the wallet view a transfer replay uses: ensure, then select
// the live balance without FOR UPDATE.
func aiBalance(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	owner, err := walletOwner(ctx, tx, orgID)
	if err != nil {
		return 0, err
	}
	var bal int64
	err = withAppWallet(ctx, tx, orgID, owner, func() error {
		if _, err := tx.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, owner); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT balance_microfen FROM user_wallets WHERE user_id = $1`, owner).Scan(&bal)
	})
	return bal, err
}

// adjust credits the workspace wallet. Failures are plain errors so the
// caller maps them to 500; the Chinese prefix stays in the log.
func adjust(ctx context.Context, tx pgx.Tx, orgID int64, key string, amount int64, note string) (int64, error) {
	if strings.TrimSpace(key) == "" {
		return 0, fmt.Errorf("钱包转入失败: a wallet movement requires an idempotency key")
	}
	owner, err := walletOwner(ctx, tx, orgID)
	if err != nil {
		return 0, fmt.Errorf("钱包转入失败: %w", err)
	}
	var after int64
	err = withAppWallet(ctx, tx, orgID, owner, func() error {
		if _, err := tx.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, owner); err != nil {
			return err
		}
		var before, held int64
		err := tx.QueryRow(ctx, `
			SELECT balance_microfen, held_microfen
			FROM user_wallets WHERE user_id = $1 FOR UPDATE`, owner).Scan(&before, &held)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("user wallet vanished after upsert")
		}
		if err != nil {
			return err
		}
		sum, ok := checkedAdd(before, amount)
		if !ok {
			return fmt.Errorf("wallet balance overflow")
		}
		if sum < held {
			return fmt.Errorf("insufficient")
		}
		tag, err := tx.Exec(ctx, `
			UPDATE user_wallets
			   SET balance_microfen = $2,
			       held_microfen = $3,
			       version = version + 1,
			       updated_at = clock_timestamp()
			 WHERE user_id = (SELECT owner_user_id FROM organizations WHERE id = $1)`,
			orgID, sum, held)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("wallet update affected %d rows for organization %d", tag.RowsAffected(), orgID)
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO wallet_ledger
			    (org_id, user_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
			     balance_before_microfen, balance_after_microfen,
			     held_before_microfen, held_after_microfen,
			     ai_request_id, payment_order_id, note)
			VALUES ($1, (SELECT owner_user_id FROM organizations WHERE id = $1), 'adjustment', $2, $3, 0, $4, $5, $6, $7, NULL, NULL, $8)`,
			orgID, key, amount, before, sum, held, held, note)
		if err != nil {
			return err
		}
		after = sum
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("钱包转入失败: %w", err)
	}
	return after, nil
}

func checkedAdd(a, b int64) (int64, bool) {
	c := a + b
	if (c > a) != (b > 0) && b != 0 {
		return 0, false
	}
	return c, true
}

func oldestOrg(ctx context.Context, tx pgx.Tx, userID int64) (int64, string, string, bool, error) {
	var id int64
	var uuid, name string
	err := tx.QueryRow(ctx, `
		SELECT id, lower(uuid::text) AS uuid, name
		FROM organizations
		WHERE owner_user_id = $1 AND dissolved_at IS NULL
		ORDER BY created_at ASC, id ASC
		LIMIT 1`, userID).Scan(&id, &uuid, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", "", false, nil
	}
	if err != nil {
		return 0, "", "", false, err
	}
	return id, uuid, name, true, nil
}
