package billingrepo

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// SetOrg records the tenant GUC. It does not change the role.
func SetOrg(ctx context.Context, tx pgx.Tx, orgID int64) error {
	_, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, tenantx.GUCCurrentOrgID, strconv.FormatInt(orgID, 10))
	return err
}

// RequireOrg refuses a write when the tenant GUC is missing or names another org.
func RequireOrg(ctx context.Context, tx pgx.Tx, orgID int64) error {
	var got string
	if err := tx.QueryRow(ctx, `SELECT current_setting($1, true)`, tenantx.GUCCurrentOrgID).Scan(&got); err != nil {
		return fmt.Errorf("app.current_org_id is unset")
	}
	if got != strconv.FormatInt(orgID, 10) {
		return fmt.Errorf("app.current_org_id is unset")
	}
	return nil
}

func withWallet(ctx context.Context, tx pgx.Tx, orgID int64, fn func() error) error {
	if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, tenantx.GUCCurrentOrgID, strconv.FormatInt(orgID, 10)); err != nil {
		return err
	}
	var previous string
	if err := tx.QueryRow(ctx, `SELECT current_user`).Scan(&previous); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		return err
	}
	err := fn()
	var resetErr error
	if previous == tenantx.RoleApp {
		_, resetErr = tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp)
	} else {
		_, resetErr = tx.Exec(ctx, `RESET ROLE`)
	}
	if resetErr != nil && err == nil {
		err = resetErr
	}
	return err
}

func ensure(ctx context.Context, tx pgx.Tx, orgID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO workspace_wallets (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, orgID)
	return err
}

func lock(ctx context.Context, tx pgx.Tx, orgID int64) (WalletRow, error) {
	if err := ensure(ctx, tx, orgID); err != nil {
		return WalletRow{}, err
	}
	var row WalletRow
	err := tx.QueryRow(ctx, `
		SELECT balance_microfen, held_microfen
		  FROM workspace_wallets WHERE org_id = $1 FOR UPDATE`, orgID).Scan(&row.BalanceMicrofen, &row.HeldMicrofen)
	if errors.Is(err, pgx.ErrNoRows) {
		return WalletRow{}, &Error{Msg: "workspace wallet vanished after upsert"}
	}
	return row, err
}

type movement struct {
	Amount    int64
	HeldDelta int64
	Balance   int64
	Held      int64
	AIRequest *int64
	Payment   *int64
	Note      string
	Found     bool
}

func existing(ctx context.Context, tx pgx.Tx, orgID int64, key, entry string) (movement, error) {
	var row movement
	var ai, pay *int64
	err := tx.QueryRow(ctx, `
		SELECT amount_microfen, held_delta_microfen, balance_after_microfen, held_after_microfen,
		       ai_request_id, payment_order_id, note
		  FROM wallet_ledger
		 WHERE org_id = $1 AND idempotency_key = $2 AND entry_type = $3
		 LIMIT 1`, orgID, key, entry).Scan(&row.Amount, &row.HeldDelta, &row.Balance, &row.Held, &ai, &pay, &row.Note)
	if errors.Is(err, pgx.ErrNoRows) {
		return movement{}, nil
	}
	if err != nil {
		return movement{}, err
	}
	row.AIRequest = ai
	row.Payment = pay
	row.Found = true
	return row, nil
}

func sameID(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func apply(ctx context.Context, tx pgx.Tx, orgID, balance, held int64) error {
	tag, err := tx.Exec(ctx, `
		UPDATE workspace_wallets
		   SET balance_microfen = $2,
		       held_microfen = $3,
		       version = version + 1,
		       updated_at = clock_timestamp()
		 WHERE org_id = $1`, orgID, balance, held)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return &Error{Msg: fmt.Sprintf("wallet update affected %d rows for organization %d", tag.RowsAffected(), orgID)}
	}
	return nil
}

func record(ctx context.Context, tx pgx.Tx, orgID int64, entry, key string, amount, heldDelta, beforeBal, afterBal, beforeHeld, afterHeld int64, ai, payment *int64, note string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO wallet_ledger
		    (org_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
		     balance_before_microfen, balance_after_microfen,
		     held_before_microfen, held_after_microfen,
		     ai_request_id, payment_order_id, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		orgID, entry, key, amount, heldDelta, beforeBal, afterBal, beforeHeld, afterHeld, ai, payment, note)
	return err
}

func requireKey(key string) (string, error) {
	key = trimKey(key)
	if key == "" {
		return "", &Error{Msg: "a wallet movement requires an idempotency key"}
	}
	return key, nil
}

func trimKey(key string) string {
	for len(key) > 0 && (key[0] == ' ' || key[0] == '\t' || key[0] == '\n' || key[0] == '\r') {
		key = key[1:]
	}
	for len(key) > 0 && (key[len(key)-1] == ' ' || key[len(key)-1] == '\t' || key[len(key)-1] == '\n' || key[len(key)-1] == '\r') {
		key = key[:len(key)-1]
	}
	return key
}

func positive(key string, amount int64) (string, error) {
	key, err := requireKey(key)
	if err != nil {
		return "", err
	}
	if amount <= 0 {
		return "", &Error{Msg: "a wallet reservation or topup requires a key and a positive amount"}
	}
	return key, nil
}

func requireHold(ctx context.Context, tx pgx.Tx, orgID int64, key string, amount int64, ai *int64) error {
	row, err := existing(ctx, tx, orgID, key, "hold")
	if err != nil {
		return err
	}
	if !row.Found || row.HeldDelta != amount || !sameID(row.AIRequest, ai) {
		return &Error{Msg: "the wallet reservation does not match this request"}
	}
	return nil
}

// HoldTx reserves amount from available balance. Balance does not change.
// A replay returns the stored post-image and does not bump version.
func HoldTx(ctx context.Context, tx pgx.Tx, orgID int64, key string, ai *int64, amount int64) (WalletRow, error) {
	key, err := positive(key, amount)
	if err != nil {
		return WalletRow{}, err
	}
	var out WalletRow
	err = withWallet(ctx, tx, orgID, func() error {
		row, err := lock(ctx, tx, orgID)
		if err != nil {
			return err
		}
		prior, err := existing(ctx, tx, orgID, key, "hold")
		if err != nil {
			return err
		}
		if prior.Found {
			if prior.HeldDelta != amount || !sameID(prior.AIRequest, ai) {
				return &Error{Msg: "hold parameters differ from the original reservation"}
			}
			out = WalletRow{BalanceMicrofen: prior.Balance, HeldMicrofen: prior.Held}
			return nil
		}
		if row.Available() < amount {
			return &Error{Insufficient: true, Available: row.Available(), Required: amount}
		}
		after := row.HeldMicrofen + amount
		if err := apply(ctx, tx, orgID, row.BalanceMicrofen, after); err != nil {
			return err
		}
		if err := record(ctx, tx, orgID, "hold", key, 0, amount, row.BalanceMicrofen, row.BalanceMicrofen, row.HeldMicrofen, after, ai, nil, ""); err != nil {
			return err
		}
		out = WalletRow{BalanceMicrofen: row.BalanceMicrofen, HeldMicrofen: after}
		return nil
	})
	return out, err
}

// ReleaseTx returns a reservation. Note is stored as given.
func ReleaseTx(ctx context.Context, tx pgx.Tx, orgID int64, key string, ai *int64, amount int64, note string) (WalletRow, error) {
	key, err := positive(key, amount)
	if err != nil {
		return WalletRow{}, err
	}
	var out WalletRow
	err = withWallet(ctx, tx, orgID, func() error {
		row, err := lock(ctx, tx, orgID)
		if err != nil {
			return err
		}
		prior, err := existing(ctx, tx, orgID, key, "release")
		if err != nil {
			return err
		}
		if prior.Found {
			if prior.HeldDelta != -amount || !sameID(prior.AIRequest, ai) || prior.Note != note {
				return &Error{Msg: "refund parameters differ from the original reservation"}
			}
			out = WalletRow{BalanceMicrofen: prior.Balance, HeldMicrofen: prior.Held}
			return nil
		}
		settled, err := existing(ctx, tx, orgID, key, "settle")
		if err != nil {
			return err
		}
		if settled.Found {
			return &Error{Msg: "a settled reservation cannot be refunded"}
		}
		if err := requireHold(ctx, tx, orgID, key, amount, ai); err != nil {
			return err
		}
		if row.HeldMicrofen < amount {
			return &Error{Msg: "wallet is missing the reservation being refunded"}
		}
		after := row.HeldMicrofen - amount
		if err := apply(ctx, tx, orgID, row.BalanceMicrofen, after); err != nil {
			return err
		}
		if err := record(ctx, tx, orgID, "release", key, 0, -amount, row.BalanceMicrofen, row.BalanceMicrofen, row.HeldMicrofen, after, ai, nil, note); err != nil {
			return err
		}
		out = WalletRow{BalanceMicrofen: row.BalanceMicrofen, HeldMicrofen: after}
		return nil
	})
	return out, err
}

// SettleTx releases the full reservation and charges min(exact, held).
func SettleTx(ctx context.Context, tx pgx.Tx, orgID int64, key string, ai *int64, held, exact int64) (Settlement, error) {
	key, err := positive(key, held)
	if err != nil {
		return Settlement{}, err
	}
	if exact < 0 {
		return Settlement{}, &Error{Msg: "a settled charge cannot be negative"}
	}
	charged := exact
	if charged > held {
		charged = held
	}
	absorbed := exact - charged
	note := ""
	if absorbed > 0 {
		note = fmt.Sprintf("platform absorbed %d microfen above the per-request ceiling", absorbed)
	}
	var out Settlement
	err = withWallet(ctx, tx, orgID, func() error {
		row, err := lock(ctx, tx, orgID)
		if err != nil {
			return err
		}
		prior, err := existing(ctx, tx, orgID, key, "settle")
		if err != nil {
			return err
		}
		if prior.Found {
			if prior.HeldDelta != -held || prior.Amount != -charged || !sameID(prior.AIRequest, ai) || prior.Note != note {
				return &Error{Msg: "settlement parameters differ from the original charge"}
			}
			out = Settlement{ChargedMicrofen: charged, AbsorbedMicrofen: absorbed, Wallet: WalletRow{BalanceMicrofen: prior.Balance, HeldMicrofen: prior.Held}}
			return nil
		}
		released, err := existing(ctx, tx, orgID, key, "release")
		if err != nil {
			return err
		}
		if released.Found {
			return &Error{Msg: "a refunded reservation cannot be settled"}
		}
		if err := requireHold(ctx, tx, orgID, key, held, ai); err != nil {
			return err
		}
		if row.HeldMicrofen < held || row.BalanceMicrofen < charged {
			return &Error{Msg: "wallet is missing the reservation being settled"}
		}
		afterBal := row.BalanceMicrofen - charged
		afterHeld := row.HeldMicrofen - held
		if err := apply(ctx, tx, orgID, afterBal, afterHeld); err != nil {
			return err
		}
		if err := record(ctx, tx, orgID, "settle", key, -charged, -held, row.BalanceMicrofen, afterBal, row.HeldMicrofen, afterHeld, ai, nil, note); err != nil {
			return err
		}
		out = Settlement{ChargedMicrofen: charged, AbsorbedMicrofen: absorbed, Wallet: WalletRow{BalanceMicrofen: afterBal, HeldMicrofen: afterHeld}}
		return nil
	})
	return out, err
}

// TopupTx credits a settled payment. Replay compares the payment order id.
func TopupTx(ctx context.Context, tx pgx.Tx, orgID int64, key string, paymentOrderID, amount int64) (WalletRow, error) {
	key, err := positive(key, amount)
	if err != nil {
		return WalletRow{}, err
	}
	var out WalletRow
	err = withWallet(ctx, tx, orgID, func() error {
		row, err := lock(ctx, tx, orgID)
		if err != nil {
			return err
		}
		prior, err := existing(ctx, tx, orgID, key, "topup")
		if err != nil {
			return err
		}
		if prior.Found {
			if prior.Amount != amount || !sameID(prior.Payment, &paymentOrderID) {
				return &Error{Msg: "topup parameters differ from the original payment"}
			}
			out = WalletRow{BalanceMicrofen: prior.Balance, HeldMicrofen: prior.Held}
			return nil
		}
		after, ok := checkedAdd(row.BalanceMicrofen, amount)
		if !ok {
			return &Error{Msg: "wallet balance overflow"}
		}
		if err := apply(ctx, tx, orgID, after, row.HeldMicrofen); err != nil {
			return err
		}
		if err := record(ctx, tx, orgID, "topup", key, amount, 0, row.BalanceMicrofen, after, row.HeldMicrofen, row.HeldMicrofen, nil, &paymentOrderID, ""); err != nil {
			return err
		}
		out = WalletRow{BalanceMicrofen: after, HeldMicrofen: row.HeldMicrofen}
		return nil
	})
	return out, err
}

// AdjustTx moves the balance. It does not short-circuit on an existing key.
func AdjustTx(ctx context.Context, tx pgx.Tx, orgID int64, key string, amount int64, note string) (WalletRow, error) {
	key, err := requireKey(key)
	if err != nil {
		return WalletRow{}, err
	}
	var out WalletRow
	err = withWallet(ctx, tx, orgID, func() error {
		row, err := lock(ctx, tx, orgID)
		if err != nil {
			return err
		}
		after, ok := checkedAdd(row.BalanceMicrofen, amount)
		if !ok {
			return &Error{Msg: "wallet balance overflow"}
		}
		if after < row.HeldMicrofen {
			required := int64(0)
			if amount < 0 {
				required = -amount
			}
			return &Error{Insufficient: true, Available: row.Available(), Required: required}
		}
		if err := apply(ctx, tx, orgID, after, row.HeldMicrofen); err != nil {
			return err
		}
		if err := record(ctx, tx, orgID, "adjustment", key, amount, 0, row.BalanceMicrofen, after, row.HeldMicrofen, row.HeldMicrofen, nil, nil, note); err != nil {
			return err
		}
		out = WalletRow{BalanceMicrofen: after, HeldMicrofen: row.HeldMicrofen}
		return nil
	})
	return out, err
}

func checkedAdd(a, b int64) (int64, bool) {
	c := a + b
	if (b > 0 && c < a) || (b < 0 && c > a) {
		return 0, false
	}
	return c, true
}

// Adjust runs one adjustment transaction.
func Adjust(ctx context.Context, pool *pgxpool.Pool, orgID int64, key string, amount int64, note string) (WalletRow, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return WalletRow{}, err
	}
	defer tx.Rollback(ctx)
	row, err := AdjustTx(ctx, tx, orgID, key, amount, note)
	if err != nil {
		return WalletRow{}, err
	}
	return row, tx.Commit(ctx)
}

// ViewTx reads the workspace wallet and its lifetime settle spend.
func ViewTx(ctx context.Context, tx pgx.Tx, orgID int64) (WalletView, error) {
	var view WalletView
	err := withWallet(ctx, tx, orgID, func() error {
		if err := ensure(ctx, tx, orgID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			SELECT w.balance_microfen,
			       w.held_microfen,
			       COALESCE((SELECT -SUM(l.amount_microfen)
			                    FROM wallet_ledger l
			                   WHERE l.org_id = w.org_id AND l.entry_type = 'settle'), 0)::bigint,
			       w.updated_at
			  FROM workspace_wallets w
			 WHERE w.org_id = $1`, orgID).Scan(
			&view.BalanceMicrofen, &view.HeldMicrofen, &view.SpentMicrofen, &view.UpdatedAt)
	})
	view.AvailableMicrofen = WalletRow{BalanceMicrofen: view.BalanceMicrofen, HeldMicrofen: view.HeldMicrofen}.Available()
	return view, err
}

// RecentLedgerTx returns newest ledger rows for this org. It does not ensure a wallet.
func RecentLedgerTx(ctx context.Context, tx pgx.Tx, orgID int64, limit int32) ([]LedgerEntryView, error) {
	var rows []LedgerEntryView
	err := withWallet(ctx, tx, orgID, func() error {
		list, err := tx.Query(ctx, `
			SELECT entry_type, amount_microfen, balance_after_microfen, note, created_at
			  FROM wallet_ledger
			 WHERE org_id = $1
			 ORDER BY id DESC
			 LIMIT $2`, orgID, limit)
		if err != nil {
			return err
		}
		defer list.Close()
		for list.Next() {
			var row LedgerEntryView
			if err := list.Scan(&row.EntryType, &row.AmountMicrofen, &row.BalanceAfterMicrofen, &row.Note, &row.CreatedAt); err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return list.Err()
	})
	return rows, err
}

// InvariantMismatch is one workspace whose cache disagrees with the ledger.
type InvariantMismatch struct {
	OrgID         int64
	WalletBalance int64
	LedgerBalance int64
	WalletHeld    int64
	LedgerHeld    int64
}

// CheckInvariant compares every wallet row with the ledger sums.
// The SQL sets no GUC. A superuser sees every workspace. podhub_app under FORCE
// RLS sees only the current org, which this function does not set.
func CheckInvariant(ctx context.Context, pool *pgxpool.Pool) ([]InvariantMismatch, error) {
	rows, err := pool.Query(ctx, `
		SELECT w.org_id,
		       w.balance_microfen,
		       w.held_microfen,
		       COALESCE(l.ledger_balance, 0)::bigint,
		       COALESCE(l.ledger_held, 0)::bigint
		  FROM workspace_wallets w
		  LEFT JOIN (
		      SELECT org_id,
		             SUM(amount_microfen)::bigint AS ledger_balance,
		             SUM(held_delta_microfen)::bigint AS ledger_held
		        FROM wallet_ledger
		       GROUP BY org_id
		  ) l USING (org_id)
		 WHERE w.balance_microfen <> COALESCE(l.ledger_balance, 0)
		    OR w.held_microfen <> COALESCE(l.ledger_held, 0)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []InvariantMismatch
	for rows.Next() {
		var row InvariantMismatch
		if err := rows.Scan(&row.OrgID, &row.WalletBalance, &row.WalletHeld, &row.LedgerBalance, &row.LedgerHeld); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
