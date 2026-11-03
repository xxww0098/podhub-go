package supplierrepo

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

func (r Repo) Accept(ctx context.Context, userID int64, dispatchID string) (contract.ActionData, error) {
	return r.act(ctx, userID, dispatchID, "接单", func(tx pgx.Tx, orgID int64, source, fulfillerID string) (string, error) {
		var state string
		err := tx.QueryRow(ctx, `SELECT delegate_supplier_accept($1::uuid, $2, $3::uuid)::text`, dispatchID, userID, fulfillerID).Scan(&state)
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
	return r.act(ctx, userID, dispatchID, "", func(tx pgx.Tx, orgID int64, _ string, fulfillerID string) (string, error) {
		var state string
		err := tx.QueryRow(ctx, `SELECT delegate_supplier_reject($1::uuid, $2, $3, $4::uuid)::text`, dispatchID, userID, reason, fulfillerID).Scan(&state)
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
	return r.act(ctx, userID, dispatchID, "发货", func(tx pgx.Tx, orgID int64, _ string, fulfillerID string) (string, error) {
		var state string
		err := tx.QueryRow(ctx, `SELECT delegate_supplier_ship($1::uuid, $2, $3, $4, $5, $6::uuid)::text`,
			dispatchID, userID, tracking, note, nowMs, fulfillerID).Scan(&state)
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

// actFn is what a packet action does once act has resolved the packet and
// entered the tenant. It receives the fulfiller the packet is pinned to: the
// definer functions in 00364 gate on that id, not on the source, so a caller
// that cannot name it cannot act.
type actFn func(tx pgx.Tx, orgID int64, source string, fulfillerID string) (string, error)

func (r Repo) act(ctx context.Context, userID int64, dispatchID, verb string, fn actFn) (contract.ActionData, error) {
	var out contract.ActionData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := loadFulfillerSources(ctx, tx); err != nil {
			return err
		}
		if err := assertEntitlement(ctx, tx); err != nil {
			return err
		}
		var orgID int64
		var source string
		// A packet with no fulfiller predates 00362 and cannot be acted on: the
		// definer gate would reject a NULL id anyway, so say so plainly instead
		// of letting it surface as a foreign-key or not-found error.
		var fulfillerID *string
		err := tx.QueryRow(ctx, `
			SELECT d.org_id, d.source_id, d.fulfiller_id::text FROM delegate_dispatches d
			WHERE d.dispatch_id = $1::uuid LIMIT 1`, dispatchID).Scan(&orgID, &source, &fulfillerID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "not_found", "派发包不存在")
		}
		if err != nil {
			return mapDB(err)
		}
		if fulfillerID == nil || *fulfillerID == "" {
			return fail(409, "conflict", "派发包尚未绑定履约方，请联系平台")
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
		state, err := fn(tx, orgID, source, *fulfillerID)
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
	if r.holdTx == nil {
		return errors.New("结算未装配")
	}
	_, err = r.holdTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, amount)
	return err
}

func quoteDispatch(ctx context.Context, tx pgx.Tx, dispatchID string) (cents, micro int64, breakdown []byte, err error) {
	var lines int
	var missing int
	var total int64
	err = tx.QueryRow(ctx, `
		SELECT line_count, missing_count, total_cents
		FROM supplier_dispatch_quote($1::uuid)`, dispatchID).Scan(&lines, &missing, &total)
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
		if r.holdTx == nil || r.settleTx == nil {
			return errors.New("结算未装配")
		}
		if _, err := r.holdTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, micro); err != nil {
			return err
		}
		if _, err := r.settleTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, micro, micro); err != nil {
			return err
		}
		return creditDispatch(ctx, tx, dispatchID, nowMs)
	case err != nil:
		return err
	case state == "settled":
		return nil
	case state == "released":
		return errors.New("refunded reservation")
	case state == "held":
		if r.settleTx == nil {
			return errors.New("结算未装配")
		}
		if _, err := r.settleTx(ctx, tx, orgID, "delegate:"+dispatchID, nil, amount, amount); err != nil {
			return err
		}
		if err := creditDispatch(ctx, tx, dispatchID, nowMs); err != nil {
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

// creditDispatch pays the factory. Since 00363 dropped the source arm from
// the supplier money tables, a supplier session cannot touch them at all,
// so the write goes through a definer function that takes only the dispatch
// id. See the comment on delegate_credit_fulfiller_wallet for why it is not
// a standalone money faucet.
func creditDispatch(ctx context.Context, tx pgx.Tx, dispatchID string, nowMs int64) error {
	var id pgtype.UUID
	if err := id.Scan(dispatchID); err != nil || !id.Valid {
		return errors.New("派发包不存在")
	}
	_, err := tx.Exec(ctx, `SELECT public.delegate_credit_fulfiller_wallet($1::uuid, $2)`, id, nowMs)
	return err
}

// add is checked addition: ok is false when the sum overflows int64.
func add(a, b int64) (int64, bool) {
	c := a + b
	if (b > 0 && c < a) || (b < 0 && c > a) {
		return 0, false
	}
	return c, true
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
