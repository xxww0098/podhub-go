package supplierrepo

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	bill "github.com/xxww0098/podhub-go/internal/billing/contract"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

func (r Repo) Accept(ctx context.Context, userID int64, dispatchID string) (contract.ActionData, error) {
	return r.act(ctx, userID, dispatchID, "接单", func(tx pgx.Tx, orgID int64, source string) (string, error) {
		var state string
		err := tx.QueryRow(ctx, `SELECT delegate_supplier_accept($1::uuid, $2)::text`, dispatchID, userID).Scan(&state)
		if err != nil {
			return "", mapDB(err)
		}
		if err := r.holdOnAccept(ctx, tx, dispatchID); err != nil {
			return "", mapMoney(err, "接单")
		}
		raw, _ := json.Marshal(struct {
			State    string `json:"state"`
			SourceID string `json:"sourceId"`
		}{state, source})
		if err := insertAuditRaw(ctx, tx, orgID, userID, "delegate_dispatch", dispatchID, "POST",
			"/api/supplier/dispatches/"+dispatchID+"/accept", "delegate_dispatch_accepted", raw); err != nil {
			return "", err
		}
		return state, nil
	})
}

func (r Repo) Reject(ctx context.Context, userID int64, dispatchID, reason string) (contract.ActionData, error) {
	return r.act(ctx, userID, dispatchID, "", func(tx pgx.Tx, orgID int64, _ string) (string, error) {
		var state string
		err := tx.QueryRow(ctx, `SELECT delegate_supplier_reject($1::uuid, $2, $3)::text`, dispatchID, userID, reason).Scan(&state)
		if err != nil {
			return "", mapDB(err)
		}
		raw, _ := json.Marshal(struct {
			State  string `json:"state"`
			Reason string `json:"reason"`
		}{state, reason})
		if err := insertAuditRaw(ctx, tx, orgID, userID, "delegate_dispatch", dispatchID, "POST",
			"/api/supplier/dispatches/"+dispatchID+"/reject", "delegate_dispatch_rejected", raw); err != nil {
			return "", err
		}
		if err := notify(ctx, tx, orgID, dispatchID, "rejected", "", reason); err != nil {
			return "", mapDB(err)
		}
		return state, nil
	})
}

func (r Repo) Ship(ctx context.Context, userID int64, dispatchID, tracking, note string, nowMs int64) (contract.ActionData, error) {
	return r.act(ctx, userID, dispatchID, "发货", func(tx pgx.Tx, orgID int64, _ string) (string, error) {
		var state string
		err := tx.QueryRow(ctx, `SELECT delegate_supplier_ship($1::uuid, $2, $3, $4, $5)::text`,
			dispatchID, userID, tracking, note, nowMs).Scan(&state)
		if err != nil {
			return "", mapDB(err)
		}
		if err := r.settleDispatch(ctx, tx, dispatchID, nowMs); err != nil {
			return "", mapMoney(err, "发货")
		}
		body, _ := json.Marshal(struct {
			State         string `json:"state"`
			HasTrackingNo bool   `json:"hasTrackingNo"`
		}{state, tracking != ""})
		if err := insertAuditRaw(ctx, tx, orgID, userID, "delegate_dispatch", dispatchID, "POST",
			"/api/supplier/dispatches/"+dispatchID+"/ship", "delegate_dispatch_shipped", body); err != nil {
			return "", err
		}
		track := ""
		if tracking != "" {
			track = tracking
		}
		if err := notify(ctx, tx, orgID, dispatchID, "shipped", track, ""); err != nil {
			return "", mapDB(err)
		}
		return state, nil
	})
}

type actFn func(tx pgx.Tx, orgID int64, source string) (string, error)

func (r Repo) act(ctx context.Context, userID int64, dispatchID, verb string, fn actFn) (contract.ActionData, error) {
	var out contract.ActionData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		if err := assertEntitlement(ctx, tx); err != nil {
			return err
		}
		var orgID int64
		var source string
		err := tx.QueryRow(ctx, `
			SELECT d.org_id, d.source_id FROM delegate_dispatches d
			WHERE d.dispatch_id = $1::uuid LIMIT 1`, dispatchID).Scan(&orgID, &source)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "not_found", "派发包不存在")
		}
		if err != nil {
			return mapDB(err)
		}
		if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
			return mapDB(err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_supplier_user_id', $1, true)`, strconv.FormatInt(userID, 10)); err != nil {
			return mapDB(err)
		}
		var dissolved bool
		err = tx.QueryRow(ctx, `
			SELECT dissolved_at IS NOT NULL FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&dissolved)
		if errors.Is(err, pgx.ErrNoRows) || dissolved {
			return fail(409, "conflict", "卖家工作空间已解散")
		}
		if err != nil {
			return mapDB(err)
		}
		state, err := fn(tx, orgID, source)
		if err != nil {
			if verb != "" {
				return mapMoney(err, verb)
			}
			return err
		}
		if state == "" {
			return fail(404, "not_found", "派发包不存在")
		}
		out = contract.ActionData{DispatchID: dispatchID, State: state}
		_ = source
		return nil
	})
	return out, err
}

func (r Repo) holdOnAccept(ctx context.Context, tx pgx.Tx, dispatchID string) error {
	var orgID int64
	var state string
	var amount int64
	err := tx.QueryRow(ctx, `
		SELECT org_id, state, amount_microfen FROM delegate_settlements
		WHERE dispatch_id = $1::uuid FOR UPDATE`, dispatchID).Scan(&orgID, &state, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		cents, micro, breakdown, err := quoteDispatch(ctx, tx, dispatchID)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO delegate_settlements (
			    org_id, order_id, dispatch_id, source_id,
			    amount_cents, amount_microfen, state, breakdown, held_at_ms, settled_at_ms)
			SELECT org_id, order_id, dispatch_id, source_id, $2, $3, 'held', $4::jsonb,
			       (extract(epoch from clock_timestamp()) * 1000)::bigint, NULL
			FROM delegate_dispatches WHERE dispatch_id = $1::uuid
			RETURNING org_id`, dispatchID, cents, micro, breakdown).Scan(&orgID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("结算没有写入")
		}
		if err != nil {
			return err
		}
		amount = micro
	} else if err != nil {
		return err
	} else if state != "held" {
		return errors.New("结算已结束，不能再接单")
	}
	_, err = bill.HoldTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, amount)
	return err
}

func quoteDispatch(ctx context.Context, tx pgx.Tx, dispatchID string) (cents, micro int64, breakdown []byte, err error) {
	var lines int
	var missing int
	var total int64
	err = tx.QueryRow(ctx, `
		SELECT COUNT(*)::int,
		       COALESCE(SUM(CASE WHEN priced.unit_cents IS NULL OR priced.unit_cents <= 0 THEN 1 ELSE 0 END), 0)::int,
		       COALESCE(SUM(CASE WHEN priced.unit_cents > 0 THEN GREATEST(COALESCE(l.quantity, 1), 1) * priced.unit_cents ELSE 0 END), 0)::bigint
		FROM delegate_dispatches d
		CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(d.payload->'lines', '[]'::jsonb)) AS l(offer_id text, quantity int)
		LEFT JOIN LATERAL (
		    SELECT COALESCE(o.cost_cents, 0) + COALESCE(o.shipping_cost_cents, 0) AS unit_cents
		    FROM sc_skus k
		    JOIN sc_source_offers o ON o.sku_id = k.sku_id AND o.source_id = d.source_id
		    WHERE k.platform_code = l.offer_id
		    LIMIT 1
		) priced ON true
		WHERE d.dispatch_id = $1::uuid`, dispatchID).Scan(&lines, &missing, &total)
	if err != nil {
		return 0, 0, nil, err
	}
	if lines == 0 || missing > 0 || total <= 0 {
		return 0, 0, nil, errors.New("未标成本")
	}
	if total > (1<<63-1)/contract.MicrofenPerCent {
		return 0, 0, nil, errors.New("结算金额超出范围")
	}
	breakdown, _ = json.Marshal([]any{})
	return total, total * contract.MicrofenPerCent, breakdown, nil
}

func (r Repo) settleDispatch(ctx context.Context, tx pgx.Tx, dispatchID string, nowMs int64) error {
	var orgID int64
	var state string
	var amount int64
	var source string
	err := tx.QueryRow(ctx, `
		SELECT org_id, state, amount_microfen, source_id FROM delegate_settlements
		WHERE dispatch_id = $1::uuid FOR UPDATE`, dispatchID).Scan(&orgID, &state, &amount, &source)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		cents, micro, breakdown, err := quoteDispatch(ctx, tx, dispatchID)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO delegate_settlements (
			    org_id, order_id, dispatch_id, source_id,
			    amount_cents, amount_microfen, state, breakdown, held_at_ms, settled_at_ms)
			SELECT org_id, order_id, dispatch_id, source_id, $2, $3, 'settled', $4::jsonb, $5, $5
			FROM delegate_dispatches WHERE dispatch_id = $1::uuid
			RETURNING org_id, source_id`, dispatchID, cents, micro, breakdown, nowMs).Scan(&orgID, &source)
		if err != nil {
			return errors.New("结算没有写入")
		}
		if _, err := bill.HoldTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, micro); err != nil {
			return err
		}
		if _, err := bill.SettleTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, micro, micro); err != nil {
			return err
		}
		return creditDispatch(ctx, tx, source, dispatchID, micro, nowMs)
	case err != nil:
		return err
	case state == "settled":
		return nil
	case state == "released":
		return errors.New("refunded reservation")
	case state == "held":
		if _, err := bill.SettleTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, amount, amount); err != nil {
			return err
		}
		if err := creditDispatch(ctx, tx, source, dispatchID, amount, nowMs); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE delegate_settlements SET state = 'settled', settled_at_ms = $2
			WHERE dispatch_id = $1::uuid AND state = 'held'`, dispatchID, nowMs)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("结算状态已变化")
		}
		return nil
	default:
		return errors.New("结算状态异常")
	}
}

func creditDispatch(ctx context.Context, tx pgx.Tx, source, dispatchID string, amount, nowMs int64) error {
	return moveCash(ctx, tx, source, "credit", "delegate:"+dispatchID, amount, amount, 0, nowMs, true)
}

func moveCash(ctx context.Context, tx pgx.Tx, source, entryType, key string, amount, balanceDelta, heldDelta, nowMs int64, create bool) error {
	if create {
		if _, err := tx.Exec(ctx, `
			INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
			VALUES ($1, 0, 0, $2)
			ON CONFLICT (source_id) DO NOTHING`, source, nowMs); err != nil {
			return err
		}
	}
	var balance, held int64
	err := tx.QueryRow(ctx, `
		SELECT balance_microfen, held_microfen FROM supplier_wallets
		WHERE source_id = $1 FOR UPDATE`, source).Scan(&balance, &held)
	if errors.Is(err, pgx.ErrNoRows) {
		if create {
			return errors.New("厂家钱包不可写")
		}
		return &bill.Error{Insufficient: true}
	}
	if err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM supplier_wallet_ledger
		 WHERE source_id = $1 AND entry_type = $2 AND idempotency_key = $3)`,
		source, entryType, key).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	nextBal, ok1 := add(balance, balanceDelta)
	nextHeld, ok2 := add(held, heldDelta)
	if !ok1 || !ok2 {
		return errors.New("结算金额超出范围")
	}
	if nextBal < 0 || nextHeld < 0 || nextHeld > nextBal {
		return &bill.Error{Insufficient: true}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE supplier_wallets
		SET balance_microfen = $2, held_microfen = $3, updated_at_ms = $4
		WHERE source_id = $1`, source, nextBal, nextHeld, nowMs)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("厂家钱包不可写")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO supplier_wallet_ledger
		    (source_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
		     balance_after_microfen, held_after_microfen, created_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		source, entryType, key, amount, heldDelta, nextBal, nextHeld, nowMs)
	return err
}

func add(a, b int64) (int64, bool) {
	c := a + b
	if (b > 0 && c < a) || (b < 0 && c > a) {
		return 0, false
	}
	return c, true
}

func (r Repo) CreateWithdrawal(ctx context.Context, userID int64, in domain.WithdrawalInput, nowMs int64) (contract.WithdrawalListData, error) {
	var out contract.WithdrawalListData
	id := uuid.NewString()
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		if err := assertEntitlement(ctx, tx); err != nil {
			return err
		}
		var one int
		err := tx.QueryRow(ctx, `
			SELECT 1 FROM sc_source_members
			WHERE source_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`, in.SourceID, userID).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "not_found", "厂家不存在")
		}
		if err != nil {
			return mapDB(err)
		}
		var balance, held int64
		err = tx.QueryRow(ctx, `
			SELECT balance_microfen, held_microfen FROM supplier_wallets
			WHERE source_id = $1 FOR UPDATE`, in.SourceID).Scan(&balance, &held)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(409, "conflict", "可用余额不足")
		}
		if err != nil {
			return mapDB(err)
		}
		err = tx.QueryRow(ctx, `
			SELECT 1 FROM supplier_withdrawals WHERE source_id = $1 AND status = 'requested' LIMIT 1`, in.SourceID).Scan(&one)
		if err == nil {
			return fail(409, "conflict", "这家厂家已有一笔待处理的提现")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return mapDB(err)
		}
		nextHeld, ok := add(held, in.AmountMicrofen)
		if !ok {
			return fail(409, "conflict", "结算金额超出范围")
		}
		if balance < nextHeld {
			return fail(409, "conflict", "可用余额不足")
		}
		if err := moveCash(ctx, tx, in.SourceID, "withdrawal_hold", "withdrawal:"+id, in.AmountMicrofen, 0, in.AmountMicrofen, nowMs, false); err != nil {
			return mapMoney(err, "结算")
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO supplier_withdrawals (
			    withdrawal_id, source_id, amount_cents, amount_microfen, channel,
			    account, real_name, status, requested_at_ms)
			VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'requested', $8)`,
			id, in.SourceID, in.AmountCents, in.AmountMicrofen, in.Channel, in.Account, in.RealName, nowMs); err != nil {
			var pg = mapDB(err)
			if f, ok := contract.AsFailure(pg); ok {
				return f
			}
			if isUnique(err) {
				return fail(409, "conflict", "这家厂家已有一笔待处理的提现")
			}
			return mapDB(err)
		}
		rows, err := loadWithdrawals(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		out.Withdrawals = rows
		raw, _ := json.Marshal(struct {
			SourceID    string `json:"sourceId"`
			AmountCents int64  `json:"amountCents"`
			Channel     string `json:"channel"`
		}{in.SourceID, in.AmountCents, in.Channel})
		return insertAuditRaw(ctx, tx, 0, userID, "supplier_withdrawal", id, "POST",
			"/api/supplier/withdrawals", "supplier_withdrawal_requested", raw)
	})
	return out, err
}

func assertEntitlement(ctx context.Context, tx pgx.Tx) error {
	// The portal writes under the admin lease. An entitlement lease does not gate the portal.
	_, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), time.Now().UnixMilli(), "厂家门户写入未启用")
	if writer.IsDisabled(err) {
		return fail(503, "writes_disabled", "厂家门户写入未启用")
	}
	return mapDB(err)
}

func insertAudit(ctx context.Context, tx pgx.Tx, orgID, userID int64, entityType, entityID, method, path, action string, payload map[string]any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return insertAuditRaw(ctx, tx, orgID, userID, entityType, entityID, method, path, action, raw)
}

func insertAuditRaw(ctx context.Context, tx pgx.Tx, orgID, userID int64, entityType, entityID, method, path, action string, message []byte) error {
	if orgID < 0 {
		orgID = 0
	}
	leaseID, fence := writer.AuditArgs(tx)
	tag, err := tx.Exec(ctx, `
		INSERT INTO audit_logs
		    (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		     action, status, result, message, shop_id, created_at_ms, created_at,
		     actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, 'entitlement', $3, $4, $5, $6,
		        $7, 'success', 'applied', $8, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $9, $10)`,
		orgID, userID, entityType, entityID, method, path, action, string(message), leaseID, fence)
	if err != nil {
		return mapDB(err)
	}
	if tag.RowsAffected() != 1 {
		return fail(500, "internal", "服务暂不可用")
	}
	return nil
}

func notify(ctx context.Context, tx pgx.Tx, orgID int64, dispatchID, event, tracking, reason string) error {
	var orderID, storeID, posting, dispatchNo, sourceName string
	err := tx.QueryRow(ctx, `
		SELECT o.order_id::text, o.store_id::text, o.posting_number, d.dispatch_no, COALESCE(s.name, '')
		FROM delegate_dispatches d
		JOIN delegate_orders o ON o.order_id = d.order_id
		LEFT JOIN sc_sources s ON s.source_id = d.source_id
		WHERE d.dispatch_id = $1::uuid`, dispatchID).Scan(&orderID, &storeID, &posting, &dispatchNo, &sourceName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_ = dispatchNo
	var userID *int64
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(
		    (SELECT m.user_id FROM organization_stores s
		      JOIN organization_members m ON m.id = s.assignee_membership_id
		      WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.assignee_membership_id IS NOT NULL),
		    (SELECT owner_user_id FROM organizations WHERE id = $1)
		)`, orgID, storeID).Scan(&userID)
	if err != nil || userID == nil || *userID == 0 {
		return nil
	}
	payload, _ := json.Marshal(struct {
		Event         string `json:"event"`
		OrderID       string `json:"orderId"`
		PostingNumber string `json:"postingNumber"`
		SourceName    string `json:"sourceName"`
		TrackingNo    any    `json:"trackingNo"`
		RejectReason  any    `json:"rejectReason"`
	}{event, orderID, posting, sourceName, nullIfEmpty(tracking), nullIfEmpty(reason)})
	_, err = tx.Exec(ctx, `
		INSERT INTO notifications (uuid, user_id, kind, payload, created_at)
		VALUES (gen_random_uuid(), $1, 'delegate_order_event', $2::jsonb, clock_timestamp())`, *userID, payload)
	return err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func isUnique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
