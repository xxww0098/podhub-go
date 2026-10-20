package billingrepo

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	billingcontract "github.com/xxww0098/podhub-go/internal/admin/billing/contract"
	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func withWallet(ctx context.Context, tx pgx.Tx, orgID int64, fn func(owner int64) error) error {
	var owner int64
	if err := tx.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id = $1`, orgID).Scan(&owner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config($1, $2, true), set_config('app.current_wallet_user_id', $3, true)`,
		tenantx.GUCCurrentOrgID, strconv.FormatInt(orgID, 10), strconv.FormatInt(owner, 10)); err != nil {
		return err
	}
	var previous string
	if err := tx.QueryRow(ctx, `SELECT current_user`).Scan(&previous); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		return err
	}
	err := fn(owner)
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

func ensureWallet(ctx context.Context, tx pgx.Tx, owner int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, owner)
	return err
}

func lockWallet(ctx context.Context, tx pgx.Tx, owner int64) (balance, held int64, err error) {
	if err = ensureWallet(ctx, tx, owner); err != nil {
		return 0, 0, err
	}
	err = tx.QueryRow(ctx, `
		SELECT balance_microfen, held_microfen FROM user_wallets WHERE user_id = $1 FOR UPDATE`, owner).Scan(&balance, &held)
	return balance, held, err
}

func applyWallet(ctx context.Context, tx pgx.Tx, orgID, balance, held int64) error {
	tag, err := tx.Exec(ctx, `
		UPDATE user_wallets
		   SET balance_microfen = $2, held_microfen = $3, version = version + 1, updated_at = clock_timestamp()
		 WHERE user_id = (SELECT owner_user_id FROM organizations WHERE id = $1)`, orgID, balance, held)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return corecontract.Internal("INTERNAL", corerepo.MsgUnavailable)
	}
	return nil
}

func recordWallet(ctx context.Context, tx pgx.Tx, orgID int64, entry, key string, amount, heldDelta, beforeBal, afterBal, beforeHeld, afterHeld int64, payment *int64, note string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO wallet_ledger
		    (org_id, user_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
		     balance_before_microfen, balance_after_microfen, held_before_microfen, held_after_microfen,
		     ai_request_id, payment_order_id, note)
		VALUES ($1, (SELECT owner_user_id FROM organizations WHERE id = $1),
		        $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11)`,
		orgID, entry, key, amount, heldDelta, beforeBal, afterBal, beforeHeld, afterHeld, payment, note)
	return err
}

// creditWallet settles a paid wallet order. A duplicate key fails the unique constraint
// and rolls the whole confirm back. It does not replay an earlier topup.
func creditWallet(ctx context.Context, tx pgx.Tx, orgID int64, key string, orderID, amount int64, entry, note string) error {
	return withWallet(ctx, tx, orgID, func(owner int64) error {
		balance, held, err := lockWallet(ctx, tx, owner)
		if err != nil {
			return err
		}
		after := balance + amount
		if after < held {
			return corecontract.Conflict("CONFLICT", "余额不足以撤回该充值（已被使用或冻结）")
		}
		if err := applyWallet(ctx, tx, orgID, after, held); err != nil {
			return err
		}
		return recordWallet(ctx, tx, orgID, entry, key, amount, 0, balance, after, held, held, &orderID, note)
	})
}

func (r *Entitlement) liveOrg(ctx context.Context, tx pgx.Tx, workspace string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		SELECT id FROM organizations WHERE uuid = lower($1)::uuid AND dissolved_at IS NULL LIMIT 1`, workspace).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, corecontract.NotFound("NOT_FOUND", "工作空间不存在")
	}
	return id, err
}

type topupView struct {
	ID             string `json:"id"`
	AmountMicrofen int64  `json:"amount_microfen"`
	Note           string `json:"note"`
	CreatedAt      string `json:"created_at"`
}

type walletView struct {
	BalanceMicrofen   int64       `json:"balance_microfen"`
	HeldMicrofen      int64       `json:"held_microfen"`
	AvailableMicrofen int64       `json:"available_microfen"`
	Topups            []topupView `json:"topups"`
}

func readWallet(ctx context.Context, tx pgx.Tx, orgID int64) (walletView, error) {
	var view walletView
	err := withWallet(ctx, tx, orgID, func(owner int64) error {
		if err := ensureWallet(ctx, tx, owner); err != nil {
			return err
		}
		var balance, held, spent int64
		if err := tx.QueryRow(ctx, `
			SELECT w.balance_microfen, w.held_microfen,
			       COALESCE((SELECT -SUM(l.amount_microfen) FROM wallet_ledger l
			                  WHERE l.user_id = w.user_id AND l.entry_type = 'settle'), 0)::bigint
			  FROM user_wallets w
			 WHERE w.user_id = (SELECT owner_user_id FROM organizations WHERE id = $1)`, orgID).Scan(&balance, &held, &spent); err != nil {
			return err
		}
		_ = spent
		view.BalanceMicrofen = balance
		view.HeldMicrofen = held
		view.AvailableMicrofen = balance - held
		if view.AvailableMicrofen < 0 {
			view.AvailableMicrofen = 0
		}
		rows, err := tx.Query(ctx, `
			SELECT substring(g.idempotency_key from 8) AS id, g.amount_microfen, g.note,
			       to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
			  FROM wallet_ledger g
			 WHERE g.org_id = $1 AND g.entry_type = 'adjustment'
			   AND g.idempotency_key LIKE 'manual:%' AND g.idempotency_key NOT LIKE '%:revoke'
			   AND NOT EXISTS (
			        SELECT 1 FROM wallet_ledger r
			         WHERE r.org_id = g.org_id AND r.entry_type = 'adjustment'
			           AND r.idempotency_key = g.idempotency_key || ':revoke')
			 ORDER BY g.created_at DESC, g.id DESC
			 LIMIT 50`, orgID)
		if err != nil {
			return err
		}
		defer rows.Close()
		view.Topups = []topupView{}
		for rows.Next() {
			var item topupView
			if err := rows.Scan(&item.ID, &item.AmountMicrofen, &item.Note, &item.CreatedAt); err != nil {
				return err
			}
			view.Topups = append(view.Topups, item)
		}
		return rows.Err()
	})
	return view, err
}

func (r *Entitlement) Wallet(ctx context.Context, actor corecontract.Actor, workspace string) ([]byte, error) {
	_ = actor
	if _, ok := corecontract.NormalizeUUID(workspace); !ok {
		return nil, corecontract.NotFound("NOT_FOUND", "工作空间不存在")
	}
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	orgID, err := r.liveOrg(ctx, tx, workspace)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	view, err := readWallet(ctx, tx, orgID)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	return corerepo.Data(view)
}

func uniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func (r *Entitlement) GrantTopup(ctx context.Context, actor corecontract.Actor, grant billingcontract.TopupGrant) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	held, err := corerepo.Admit(ctx, tx, "entitlement", r.now().UnixMilli(), entitlementOff)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	orgID, err := r.liveOrg(ctx, tx, grant.WorkspaceUUID)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	key := "manual:" + grant.OperationID
	amount := grant.AmountCents * 1_000_000
	replay := false
	err = withWallet(ctx, tx, orgID, func(owner int64) error {
		if _, _, err := lockWallet(ctx, tx, owner); err != nil {
			return err
		}
		var priorAmount int64
		var priorNote string
		err := tx.QueryRow(ctx, `
			SELECT amount_microfen, note FROM wallet_ledger
			 WHERE org_id = $1 AND entry_type = 'adjustment' AND idempotency_key = $2 LIMIT 1`, orgID, key).Scan(&priorAmount, &priorNote)
		if err == nil {
			if priorAmount != amount || priorNote != grant.Note {
				return corecontract.Conflict("CONFLICT", "该操作编号已用于一笔不同参数的充值")
			}
			replay = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		balance, heldBal, err := lockWallet(ctx, tx, owner)
		if err != nil {
			return err
		}
		after := balance + amount
		if after < heldBal {
			return corecontract.Conflict("CONFLICT", "余额不足以撤回该充值（已被使用或冻结）")
		}
		if err := applyWallet(ctx, tx, orgID, after, heldBal); err != nil {
			return err
		}
		return recordWallet(ctx, tx, orgID, "adjustment", key, amount, 0, balance, after, heldBal, heldBal, nil, grant.Note)
	})
	if uniqueViolation(err) {
		return nil, corecontract.Conflict("CONFLICT", "该操作编号已用于一笔不同参数的充值")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	if !replay {
		message, _ := json.Marshal(struct {
			TopupID        string `json:"topup_id"`
			AmountMicrofen int64  `json:"amount_microfen"`
			Note           string `json:"note"`
		}{grant.OperationID, amount, grant.Note})
		if err := corerepo.AuditBill(ctx, tx, orgID, actor.UserID, "ai", "wallet", grant.WorkspaceUUID, "POST",
			"/api/admin/workspaces/"+grant.WorkspaceUUID+"/wallet", "wallet_topup_granted", string(message), held); err != nil {
			return nil, corerepo.MapBill(err, "INTERNAL", false)
		}
	}
	view, err := readWallet(ctx, tx, orgID)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	return corerepo.Data(view)
}

func (r *Entitlement) RevokeTopup(ctx context.Context, actor corecontract.Actor, workspace, topupID string) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	held, err := corerepo.Admit(ctx, tx, "entitlement", r.now().UnixMilli(), entitlementOff)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	orgID, err := r.liveOrg(ctx, tx, workspace)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	var granted int64
	err = tx.QueryRow(ctx, `
		SELECT amount_microfen FROM wallet_ledger
		 WHERE org_id = $1 AND entry_type = 'adjustment' AND idempotency_key = $2 LIMIT 1`,
		orgID, "manual:"+topupID).Scan(&granted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, corecontract.NotFound("NOT_FOUND", "充值记录不存在")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	amount := -granted
	err = withWallet(ctx, tx, orgID, func(owner int64) error {
		balance, heldBal, err := lockWallet(ctx, tx, owner)
		if err != nil {
			return err
		}
		after := balance + amount
		if after < heldBal {
			return corecontract.Conflict("CONFLICT", "余额不足以撤回该充值（已被使用或冻结）")
		}
		if err := applyWallet(ctx, tx, orgID, after, heldBal); err != nil {
			return err
		}
		return recordWallet(ctx, tx, orgID, "adjustment", "manual:"+topupID+":revoke", amount, 0, balance, after, heldBal, heldBal, nil, "撤回手动充值")
	})
	if uniqueViolation(err) {
		return nil, corecontract.Conflict("CONFLICT", "该充值已撤回")
	}
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	message, _ := json.Marshal(struct {
		TopupID        string `json:"topup_id"`
		AmountMicrofen int64  `json:"amount_microfen"`
		Note           string `json:"note"`
	}{topupID, amount, ""})
	if err := corerepo.AuditBill(ctx, tx, orgID, actor.UserID, "ai", "wallet", workspace, "POST",
		"/api/admin/workspaces/"+workspace+"/wallet", "wallet_topup_revoked", string(message), held); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	view, err := readWallet(ctx, tx, orgID)
	if err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, corerepo.MapBill(err, "INTERNAL", false)
	}
	return corerepo.Data(view)
}
