package adminrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// ProcureRepo stores procurement attempts. These tables are not RLS-scoped.
type ProcureRepo struct {
	Pool *pgxpool.Pool
}

const liveStatuses = `'prepared', 'dispatching', 'unknown'`

const listSQL = `
SELECT o.order_id, o.org_id, o.listing_row_id::text AS listing_row_id,
       o.platform_sku_id, o.production_snapshot, o.quantity, o.amount_cents,
       o.currency, o.status AS order_status, o.refund_requested_at_ms,
       o.created_at_ms, o.updated_at_ms,
       p.procurement_id, p.operation_id, p.line_no, p.attempt,
       p.status AS procurement_status, p.source_id, p.channel_sku,
       p.supplier_cost_snapshot_cents, p.channel_order_ref, p.reject_reason,
       p.claimed_by_account_uuid, p.claimed_at_ms, p.lease_until_ms,
       p.dispatched_at_ms, p.receipt_at_ms,
       p.created_at_ms AS procurement_created_at_ms,
       p.updated_at_ms AS procurement_updated_at_ms
FROM public.sc_orders o
LEFT JOIN public.sc_procurements p
  ON p.platform_order_id = o.order_id
 AND p.status IN (` + liveStatuses + `)
WHERE o.status IN ('awaiting_procurement', 'processing', 'in_production')
  AND (o.status = 'awaiting_procurement' OR p.procurement_id IS NOT NULL)
ORDER BY o.updated_at_ms ASC, o.order_id ASC`

const lockOrderSQL = `
SELECT order_id, org_id, listing_row_id::text, platform_sku_id, production_snapshot,
       quantity, amount_cents, currency, status, refund_requested_at_ms, created_at_ms, updated_at_ms
FROM public.sc_orders WHERE order_id = $1 FOR UPDATE`

func (r ProcureRepo) write(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := BeginAdmin(ctx, r.Pool)
	if err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	defer writer.Forget(tx)
	if err := AssertWriteLease(ctx, tx, "采购写入未启用"); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return mapAdmin(err, "INTERNAL")
	}
	return mapAdmin(tx.Commit(ctx), "INTERNAL")
}

func (r ProcureRepo) List(ctx context.Context) ([]domain.WorkItem, error) {
	if r.Pool == nil {
		return nil, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := BeginAdmin(ctx, r.Pool)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	rows, err := tx.Query(ctx, listSQL)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	defer rows.Close()
	var out []domain.WorkItem
	for rows.Next() {
		item, err := scanWork(rows)
		if err != nil {
			return nil, mapAdmin(err, "INTERNAL")
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	return out, nil
}

func (r ProcureRepo) Claim(ctx context.Context, actor domain.Actor, in domain.ClaimInput, procurementID, operationID string, now int64) (domain.WorkItem, error) {
	var item domain.WorkItem
	err := r.write(ctx, func(tx pgx.Tx) error {
		order, err := lockOrder(ctx, tx, in.OrderID)
		if err != nil {
			return err
		}
		switch order.OrderStatus {
		case "awaiting_payment":
			return domain.Fail(400, "VALIDATION", "订单尚未进入待采购")
		case "shipped":
			return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
		}
		live, err := loadLive(ctx, tx, in.OrderID)
		if err != nil {
			return err
		}
		if live != nil {
			switch live.Status {
			case "unknown":
				return domain.Fail(409, "CONFLICT", "结果未知，须核对后再记回执，不能重新派发")
			case "dispatching":
				return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
			case "prepared":
				claimed := ""
				if live.ClaimedBy != nil {
					claimed = *live.ClaimedBy
				}
				held := claimed != "" && claimed != actor.PublicID && live.LeaseUntilMS != nil && *live.LeaseUntilMS > now
				if held {
					return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
				}
				if _, err := tx.Exec(ctx, `UPDATE public.sc_procurements
					SET claimed_by_account_uuid = $2, claimed_at_ms = $3, lease_until_ms = $4,
					    source_id = COALESCE($5, source_id),
					    channel_sku = COALESCE($6, channel_sku),
					    supplier_cost_snapshot_cents = COALESCE($7, supplier_cost_snapshot_cents),
					    updated_at_ms = $3
					WHERE procurement_id = $1 AND status = 'prepared'`,
					live.ProcurementID, actor.PublicID, now, now+1_800_000, in.SourceID, in.Channel, in.Cost); err != nil {
					return mapAdmin(err, "INTERNAL")
				}
			default:
				return domain.Fail(500, "INTERNAL", "服务暂不可用")
			}
		} else {
			if order.OrderStatus != "awaiting_procurement" && order.OrderStatus != "processing" {
				return domain.Fail(400, "VALIDATION", "订单尚未进入待采购")
			}
			var n int
			if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(attempt), 0)::int FROM public.sc_procurements WHERE platform_order_id = $1 AND line_no = 1`, in.OrderID).Scan(&n); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if _, err := tx.Exec(ctx, `INSERT INTO public.sc_procurements (
				procurement_id, operation_id, org_id, platform_order_id, line_no,
				attempt, status, source_id, channel_sku, supplier_cost_snapshot_cents,
				claimed_by_account_uuid, claimed_at_ms, lease_until_ms,
				created_at_ms, updated_at_ms, created_by_account_uuid
			) VALUES ($1,$2,$3,$4,1,$5,'prepared',$6,$7,$8,$9,$10,$11,$10,$10,$9)`,
				procurementID, operationID, order.OrgID, in.OrderID, n+1, in.SourceID, in.Channel, in.Cost, actor.PublicID, now, now+1_800_000); err != nil {
				return claimConflict(err)
			}
			if _, err := lockOrder(ctx, tx, in.OrderID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE public.sc_orders SET status = 'processing', updated_at_ms = $2 WHERE order_id = $1`, in.OrderID, now); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
		}
		loaded, err := loadWork(ctx, tx, in.OrderID)
		if err != nil {
			return err
		}
		item = loaded
		msg, _ := domain.Marshal(struct {
			OrderID     string `json:"order_id"`
			OperationID string `json:"operation_id"`
			Attempt     int32  `json:"attempt"`
		}{item.OrderID, opID(item), attemptOf(item)})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: item.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "platform_procurement",
			EntityID: procID(item), Method: "POST", Path: "/api/admin/platform-procurements/claim",
			Action: "platform_procurement_claimed", Message: string(msg),
		})
	})
	return item, err
}

func (r ProcureRepo) Dispatch(ctx context.Context, actor domain.Actor, id string, now int64) (domain.WorkItem, error) {
	var item domain.WorkItem
	err := r.write(ctx, func(tx pgx.Tx) error {
		row, err := loadByID(ctx, tx, id)
		if err != nil {
			return err
		}
		if row == nil {
			return domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		switch row.Status {
		case "dispatching":
		case "unknown":
			return domain.Fail(409, "CONFLICT", "结果未知，须核对后再记回执，不能重新派发")
		case "prepared":
			lease := int64(0)
			if row.LeaseUntilMS != nil {
				lease = *row.LeaseUntilMS
			}
			if lease <= now {
				return domain.Fail(409, "CONFLICT", "领取已过期，请重新领取")
			}
			if row.ClaimedBy == nil || *row.ClaimedBy != actor.PublicID {
				return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
			}
			tag, err := tx.Exec(ctx, `UPDATE public.sc_procurements
				SET status = 'dispatching', dispatched_at_ms = $3, updated_at_ms = $3
				WHERE procurement_id = $1 AND status = 'prepared'
				  AND claimed_by_account_uuid = $2 AND lease_until_ms > $3`,
				id, actor.PublicID, now)
			if err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if tag.RowsAffected() != 1 {
				return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
			}
			orderID := ""
			if err := tx.QueryRow(ctx, `SELECT platform_order_id FROM public.sc_procurements WHERE procurement_id = $1`, id).Scan(&orderID); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if _, err := lockOrder(ctx, tx, orderID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE public.sc_orders SET status = 'in_production', updated_at_ms = $2 WHERE order_id = $1`, orderID, now); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
		default:
			return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
		}
		orderID := ""
		if err := tx.QueryRow(ctx, `SELECT platform_order_id FROM public.sc_procurements WHERE procurement_id = $1`, id).Scan(&orderID); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		item, err = loadWork(ctx, tx, orderID)
		if err != nil {
			return err
		}
		msg, _ := domain.Marshal(struct {
			OrderID     string `json:"order_id"`
			OperationID string `json:"operation_id"`
		}{item.OrderID, opID(item)})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: item.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "platform_procurement",
			EntityID: id, Method: "POST", Path: "/api/admin/platform-procurements/{procurement_id}/dispatch",
			Action: "platform_procurement_dispatched", Message: string(msg),
		})
	})
	return item, err
}

func (r ProcureRepo) Receipt(ctx context.Context, actor domain.Actor, id string, in domain.ReceiptInput, now int64) (domain.WorkItem, error) {
	var item domain.WorkItem
	err := r.write(ctx, func(tx pgx.Tx) error {
		row, err := loadByID(ctx, tx, id)
		if err != nil {
			return err
		}
		if row == nil {
			return domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		if row.Status != "dispatching" && row.Status != "unknown" {
			return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
		}
		if !(row.Status == "unknown" && in.Outcome == "unknown") {
			var nextProc, nextOrder string
			var ref, note *string
			switch in.Outcome {
			case "accepted":
				if in.Ref == nil {
					return domain.Fail(400, "VALIDATION", "请填写外部单号")
				}
				nextProc, nextOrder, ref = "accepted", "shipped", in.Ref
			case "rejected":
				nextProc, nextOrder, note = "rejected", "awaiting_procurement", in.Note
			case "unknown":
				nextProc, nextOrder, note = "unknown", "processing", in.Note
			default:
				return domain.Fail(400, "VALIDATION", "请求格式无效")
			}
			tag, err := tx.Exec(ctx, `UPDATE public.sc_procurements
				SET status = $2, channel_order_ref = COALESCE($3, channel_order_ref),
				    reject_reason = COALESCE($4, reject_reason), receipt_at_ms = $5, updated_at_ms = $5
				WHERE procurement_id = $1 AND status IN ('dispatching', 'unknown')`,
				id, nextProc, ref, note, now)
			if err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if tag.RowsAffected() != 1 {
				return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
			}
			orderID := ""
			if err := tx.QueryRow(ctx, `SELECT platform_order_id FROM public.sc_procurements WHERE procurement_id = $1`, id).Scan(&orderID); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
			if _, err := lockOrder(ctx, tx, orderID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE public.sc_orders SET status = $2, updated_at_ms = $3 WHERE order_id = $1`, orderID, nextOrder, now); err != nil {
				return mapAdmin(err, "INTERNAL")
			}
		}
		orderID := ""
		if err := tx.QueryRow(ctx, `SELECT platform_order_id FROM public.sc_procurements WHERE procurement_id = $1`, id).Scan(&orderID); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		item, err = loadLatest(ctx, tx, orderID)
		if err != nil {
			return err
		}
		msg, _ := domain.Marshal(struct {
			OrderID     string `json:"order_id"`
			Outcome     string `json:"outcome"`
			OperationID string `json:"operation_id"`
		}{item.OrderID, in.Outcome, opID(item)})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: item.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "platform_procurement",
			EntityID: id, Method: "POST", Path: "/api/admin/platform-procurements/{procurement_id}/receipt",
			Action: "platform_procurement_receipt", Message: string(msg),
		})
	})
	return item, err
}

func (r ProcureRepo) Refund(ctx context.Context, actor domain.Actor, orderID string, now int64) (string, int64, error) {
	var at int64
	err := r.write(ctx, func(tx pgx.Tx) error {
		order, err := lockOrder(ctx, tx, orderID)
		if err != nil {
			return err
		}
		if order.OrderStatus == "awaiting_payment" {
			return domain.Fail(400, "VALIDATION", "未付款的平台订单不能申请退款")
		}
		at = now
		if order.RefundAtMS != nil {
			at = *order.RefundAtMS
		} else if _, err := tx.Exec(ctx, `UPDATE public.sc_orders SET refund_requested_at_ms = $2, updated_at_ms = $2 WHERE order_id = $1 AND refund_requested_at_ms IS NULL`, orderID, now); err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		var orgID int64
		err = tx.QueryRow(ctx, `SELECT org_id FROM public.sc_orders WHERE order_id = $1`, orderID).Scan(&orgID)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		if err != nil {
			return mapAdmin(err, "INTERNAL")
		}
		msg, _ := domain.Marshal(struct {
			RefundAtMS int64 `json:"refund_requested_at_ms"`
		}{at})
		return InsertAudit(ctx, tx, domain.Audit{
			OrgID: orgID, UserID: actor.UserID, Module: "admin", EntityType: "platform_order",
			EntityID: orderID, Method: "POST", Path: "/api/admin/platform-orders/{order_id}/request-refund",
			Action: "platform_order_refund_requested", Message: string(msg),
		})
	})
	return orderID, at, err
}

func lockOrder(ctx context.Context, tx pgx.Tx, id string) (domain.WorkItem, error) {
	var item domain.WorkItem
	var snap []byte
	err := tx.QueryRow(ctx, lockOrderSQL, id).Scan(
		&item.OrderID, &item.OrgID, &item.ListingRowID, &item.PlatformSKUID, &snap,
		&item.Quantity, &item.AmountCents, &item.Currency, &item.OrderStatus, &item.RefundAtMS,
		&item.CreatedAtMS, &item.UpdatedAtMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.WorkItem{}, domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	if err != nil {
		return domain.WorkItem{}, mapAdmin(err, "INTERNAL")
	}
	if !knownOrderStatus(item.OrderStatus) {
		return domain.WorkItem{}, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	item.ProductionFiles = domain.ProductionFiles(snap)
	item.LineNo = 1
	return item, nil
}

func loadLive(ctx context.Context, tx pgx.Tx, orderID string) (*domain.Attempt, error) {
	rows, err := tx.Query(ctx, `SELECT procurement_id, operation_id, line_no, attempt, status, source_id, channel_sku,
		supplier_cost_snapshot_cents, channel_order_ref, reject_reason, claimed_by_account_uuid,
		claimed_at_ms, lease_until_ms, dispatched_at_ms, receipt_at_ms, created_at_ms, updated_at_ms
		FROM public.sc_procurements
		WHERE platform_order_id = $1 AND line_no = 1 AND status IN (`+liveStatuses+`) LIMIT 1`, orderID)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	a, err := scanAttempt(rows)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	return &a, nil
}

func loadByID(ctx context.Context, tx pgx.Tx, id string) (*domain.Attempt, error) {
	rows, err := tx.Query(ctx, `SELECT procurement_id, operation_id, line_no, attempt, status, source_id, channel_sku,
		supplier_cost_snapshot_cents, channel_order_ref, reject_reason, claimed_by_account_uuid,
		claimed_at_ms, lease_until_ms, dispatched_at_ms, receipt_at_ms, created_at_ms, updated_at_ms
		FROM public.sc_procurements WHERE procurement_id = $1`, id)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	a, err := scanAttempt(rows)
	if err != nil {
		return nil, mapAdmin(err, "INTERNAL")
	}
	return &a, nil
}

func loadWork(ctx context.Context, tx pgx.Tx, orderID string) (domain.WorkItem, error) {
	item, err := loadOrder(ctx, tx, orderID)
	if err != nil {
		return domain.WorkItem{}, err
	}
	live, err := loadLive(ctx, tx, orderID)
	if err != nil {
		return domain.WorkItem{}, err
	}
	item.Procurement = live
	item.LineNo = 1
	return item, nil
}

func loadLatest(ctx context.Context, tx pgx.Tx, orderID string) (domain.WorkItem, error) {
	item, err := loadOrder(ctx, tx, orderID)
	if err != nil {
		return domain.WorkItem{}, err
	}
	live, err := loadLive(ctx, tx, orderID)
	if err != nil {
		return domain.WorkItem{}, err
	}
	if live == nil {
		rows, err := tx.Query(ctx, `SELECT procurement_id, operation_id, line_no, attempt, status, source_id, channel_sku,
			supplier_cost_snapshot_cents, channel_order_ref, reject_reason, claimed_by_account_uuid,
			claimed_at_ms, lease_until_ms, dispatched_at_ms, receipt_at_ms, created_at_ms, updated_at_ms
			FROM public.sc_procurements WHERE platform_order_id = $1 AND line_no = 1
			ORDER BY attempt DESC LIMIT 1`, orderID)
		if err != nil {
			return domain.WorkItem{}, mapAdmin(err, "INTERNAL")
		}
		defer rows.Close()
		if rows.Next() {
			a, err := scanAttempt(rows)
			if err != nil {
				return domain.WorkItem{}, mapAdmin(err, "INTERNAL")
			}
			live = &a
		}
	}
	item.Procurement = live
	item.LineNo = 1
	return item, nil
}

func loadOrder(ctx context.Context, tx pgx.Tx, id string) (domain.WorkItem, error) {
	var item domain.WorkItem
	var snap []byte
	err := tx.QueryRow(ctx, `SELECT order_id, org_id, listing_row_id::text, platform_sku_id, production_snapshot,
		quantity, amount_cents, currency, status, refund_requested_at_ms, created_at_ms, updated_at_ms
		FROM public.sc_orders WHERE order_id = $1`, id).Scan(
		&item.OrderID, &item.OrgID, &item.ListingRowID, &item.PlatformSKUID, &snap,
		&item.Quantity, &item.AmountCents, &item.Currency, &item.OrderStatus, &item.RefundAtMS,
		&item.CreatedAtMS, &item.UpdatedAtMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.WorkItem{}, domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	if err != nil {
		return domain.WorkItem{}, mapAdmin(err, "INTERNAL")
	}
	if !knownOrderStatus(item.OrderStatus) {
		return domain.WorkItem{}, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	item.ProductionFiles = domain.ProductionFiles(snap)
	item.LineNo = 1
	return item, nil
}

func scanWork(row pgx.Row) (domain.WorkItem, error) {
	var item domain.WorkItem
	var snap []byte
	var procID, opID, status, source, channel, ref, reason, claimed *string
	var line, attempt *int32
	var cost, claimedAt, lease, dispatched, receipt, created, updated *int64
	err := row.Scan(&item.OrderID, &item.OrgID, &item.ListingRowID, &item.PlatformSKUID, &snap,
		&item.Quantity, &item.AmountCents, &item.Currency, &item.OrderStatus, &item.RefundAtMS,
		&item.CreatedAtMS, &item.UpdatedAtMS,
		&procID, &opID, &line, &attempt, &status, &source, &channel, &cost, &ref, &reason, &claimed,
		&claimedAt, &lease, &dispatched, &receipt, &created, &updated)
	if err != nil {
		return domain.WorkItem{}, err
	}
	if !knownOrderStatus(item.OrderStatus) {
		return domain.WorkItem{}, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	item.ProductionFiles = domain.ProductionFiles(snap)
	item.LineNo = 1
	if procID == nil {
		return domain.FillWork(item), nil
	}
	if opID == nil || attempt == nil || status == nil || created == nil || updated == nil {
		return domain.WorkItem{}, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	if !knownProcStatus(*status) {
		return domain.WorkItem{}, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	if line != nil {
		item.LineNo = *line
	}
	item.Procurement = &domain.Attempt{
		ProcurementID: *procID, OperationID: *opID, Attempt: *attempt, Status: *status,
		SourceID: source, ChannelSKU: channel, CostCents: cost, ChannelOrderRef: ref, RejectReason: reason,
		ClaimedBy: claimed, ClaimedAtMS: claimedAt, LeaseUntilMS: lease, DispatchedAtMS: dispatched, ReceiptAtMS: receipt,
		CreatedAtMS: *created, UpdatedAtMS: *updated,
	}
	return domain.FillWork(item), nil
}

func scanAttempt(row pgx.Row) (domain.Attempt, error) {
	var a domain.Attempt
	if err := row.Scan(&a.ProcurementID, &a.OperationID, new(int32), &a.Attempt, &a.Status, &a.SourceID, &a.ChannelSKU,
		&a.CostCents, &a.ChannelOrderRef, &a.RejectReason, &a.ClaimedBy, &a.ClaimedAtMS, &a.LeaseUntilMS,
		&a.DispatchedAtMS, &a.ReceiptAtMS, &a.CreatedAtMS, &a.UpdatedAtMS); err != nil {
		return domain.Attempt{}, err
	}
	if !knownProcStatus(a.Status) {
		return domain.Attempt{}, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	return a, nil
}

func knownOrderStatus(s string) bool {
	switch s {
	case "awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped":
		return true
	default:
		return false
	}
}

func knownProcStatus(s string) bool {
	switch s {
	case "prepared", "dispatching", "accepted", "rejected", "unknown":
		return true
	default:
		return false
	}
}

func claimConflict(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return domain.Fail(409, "CONFLICT", "该履约单元已有进行中的采购尝试")
	}
	return mapAdmin(err, "INTERNAL")
}

func procID(item domain.WorkItem) string {
	if item.Procurement == nil {
		return ""
	}
	return item.Procurement.ProcurementID
}

func opID(item domain.WorkItem) string {
	if item.Procurement == nil {
		return ""
	}
	return item.Procurement.OperationID
}

func attemptOf(item domain.WorkItem) int32 {
	if item.Procurement == nil {
		return 0
	}
	return item.Procurement.Attempt
}
