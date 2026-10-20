package delegaterepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	delegatecontract "github.com/xxww0098/podhub-go/internal/admin/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/admin/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// DelegateRepo reads delegate orders with staff access and no org GUC.
type DelegateRepo struct {
	Pool *pgxpool.Pool
}

const orderListSQL = `
SELECT o.order_id::text AS order_id, o.org_id, o.store_id::text AS store_id,
       o.posting_number, o.state, o.cancel_requested,
       o.created_at_ms, o.updated_at_ms,
       (SELECT count(*) FROM delegate_order_lines l
        WHERE l.order_id = o.order_id) AS line_count,
       (SELECT COALESCE(jsonb_agg(DISTINCT s.name), '[]'::jsonb)
        FROM sc_sources s
        WHERE s.source_id IN (
            SELECT b.source_id FROM delegate_order_lines l
              JOIN delegate_bindings b ON b.binding_id = l.binding_id
              WHERE l.order_id = o.order_id
            UNION
            SELECT d.source_id FROM delegate_dispatches d
              WHERE d.order_id = o.order_id)) AS source_names
  FROM delegate_orders o
 WHERE ($1 = 0 OR o.org_id = $1)
   AND ($2 = '' OR o.state = $2)
   AND ($3 = '' OR EXISTS (
          SELECT 1 FROM delegate_order_lines l
            JOIN delegate_bindings b ON b.binding_id = l.binding_id
           WHERE l.order_id = o.order_id AND b.source_id = $3)
       OR EXISTS (
          SELECT 1 FROM delegate_dispatches d
           WHERE d.order_id = o.order_id AND d.source_id = $3))
   AND ($4::bigint IS NULL
        OR o.created_at_ms < $4
        OR (o.created_at_ms = $4 AND o.order_id < $5::uuid))
 ORDER BY o.created_at_ms DESC, o.order_id DESC
 LIMIT $6`

func (r DelegateRepo) staff(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return corecontract.Fail(500, "internal", "服务暂不可用")
	}
	err := db.InTx(ctx, r.Pool, db.Staff(), func(tx pgx.Tx) error {
		defer corerepo.EndLease(tx)
		return fn(tx)
	})
	return corerepo.MapAdmin(err, "internal")
}

// List runs the admin queue SQL.
func (r DelegateRepo) List(ctx context.Context, q delegatecontract.OrderQuery) (delegatecontract.OrderListResponse, error) {
	var rowsOut []delegatecontract.OrderRow
	err := r.staff(ctx, func(tx pgx.Tx) error {
		var ms any
		var id any
		if q.CursorMS != nil {
			ms = *q.CursorMS
			id = q.CursorID
		}
		rows, err := tx.Query(ctx, orderListSQL, q.OrgID, q.State, q.SourceID, ms, id, q.Limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row delegatecontract.OrderRow
			var names []byte
			if err := rows.Scan(&row.OrderID, &row.OrgID, &row.StoreID, &row.PostingNumber, &row.State, &row.CancelRequested, &row.CreatedAtMs, &row.UpdatedAtMs, &row.LineCount, &names); err != nil {
				return err
			}
			row.SourceNames = domain.StringList(names)
			rowsOut = append(rowsOut, row)
		}
		return rows.Err()
	})
	if err != nil {
		return delegatecontract.OrderListResponse{}, err
	}
	return domain.Page(rowsOut, q.Limit), nil
}

// Get loads the detail, lines, ledger, and billing figures.
func (r DelegateRepo) Get(ctx context.Context, orderID string) (delegatecontract.OrderDetailResponse, error) {
	var out delegatecontract.OrderDetailResponse
	err := r.staff(ctx, func(tx pgx.Tx) error {
		var snap, logistics []byte
		order := &out.Data.Order.Order
		err := tx.QueryRow(ctx, `SELECT order_id::text AS order_id, store_id::text AS store_id,
			posting_number, seller_note, state, cancel_requested, posting_snapshot, logistics,
			created_at_ms, updated_at_ms
			FROM delegate_orders WHERE order_id = $1::uuid LIMIT 1`, orderID).
			Scan(&order.OrderID, &order.StoreID, &order.PostingNumber, &order.SellerNote, &order.State, &order.CancelRequested, &snap, &logistics, &order.CreatedAtMs, &order.UpdatedAtMs)
		if errors.Is(err, pgx.ErrNoRows) {
			return corecontract.Fail(404, "not_found", "委托单不存在")
		}
		if err != nil {
			return err
		}
		order.PostingSnapshot = domain.ProjectPostingSnapshot(snap)
		if len(logistics) > 0 {
			order.Logistics = logistics
		}
		lines, err := tx.Query(ctx, `SELECT l.line_id::text AS line_id, l.offer_id,
			l.sku, l.name, l.quantity,
			s.source_id AS source_id, s.name AS source_name,
			s.country AS source_country, s.icon AS source_icon,
			(SELECT d.state FROM delegate_dispatches d
			 WHERE d.order_id = l.order_id
			   AND d.payload->'lines' @> to_jsonb(jsonb_build_array(
			       jsonb_build_object('line_id', l.line_id::text)))
			 ORDER BY d.created_at_ms DESC, d.dispatch_id DESC
			 LIMIT 1) AS packet_state
			FROM delegate_order_lines l
			LEFT JOIN delegate_bindings b ON b.binding_id = l.binding_id
			LEFT JOIN sc_sources s ON s.source_id = b.source_id
			WHERE l.order_id = $1::uuid
			ORDER BY l.line_id`, orderID)
		if err != nil {
			return err
		}
		for lines.Next() {
			var line delegatecontract.LineView
			var sourceID, sourceName, country, icon, packet *string
			if err := lines.Scan(&line.LineID, &line.OfferID, &line.SKU, &line.Name, &line.Quantity, &sourceID, &sourceName, &country, &icon, &packet); err != nil {
				lines.Close()
				return err
			}
			if sourceID != nil {
				line.Source = &delegatecontract.SourceView{SourceID: *sourceID, Name: str(sourceName), Country: str(country), Icon: str(icon)}
			}
			line.PacketState = packet
			order.Lines = append(order.Lines, line)
		}
		lines.Close()
		if err := lines.Err(); err != nil {
			return err
		}
		if order.Lines == nil {
			order.Lines = []delegatecontract.LineView{}
		}
		ledger, err := tx.Query(ctx, `SELECT d.dispatch_id::text AS dispatch_id, d.dispatch_no,
			d.source_id AS source_id,
			s.name AS source_name, s.country AS source_country,
			s.icon AS source_icon,
			d.state, d.attempted_by, d.receipt,
			COALESCE(jsonb_array_length(d.payload->'lines'), 0)::bigint AS line_count,
			d.created_at_ms, d.updated_at_ms
			FROM delegate_dispatches d
			LEFT JOIN sc_sources s ON s.source_id = d.source_id
			WHERE d.order_id = $1::uuid
			ORDER BY d.created_at_ms ASC, d.dispatch_id ASC`, orderID)
		if err != nil {
			return err
		}
		for ledger.Next() {
			var row delegatecontract.LedgerRow
			var name, country, icon *string
			var receipt []byte
			if err := ledger.Scan(&row.DispatchID, &row.DispatchNo, &row.Source.SourceID, &name, &country, &icon, &row.State, &row.AttemptedBy, &receipt, &row.LineCount, &row.CreatedAtMs, &row.UpdatedAtMs); err != nil {
				ledger.Close()
				return err
			}
			row.Source.Name = str(name)
			row.Source.Country = str(country)
			row.Source.Icon = str(icon)
			row.Receipt = domain.ProjectReceipt(receipt)
			out.Data.Order.Ledger = append(out.Data.Order.Ledger, row)
		}
		ledger.Close()
		if err := ledger.Err(); err != nil {
			return err
		}
		if out.Data.Order.Ledger == nil {
			out.Data.Order.Ledger = []delegatecontract.LedgerRow{}
		}
		err = tx.QueryRow(ctx, `SELECT
			COALESCE(SUM(amount_cents) FILTER (WHERE state = 'held'), 0)::bigint,
			COALESCE(SUM(amount_cents) FILTER (WHERE state = 'settled'), 0)::bigint
			FROM delegate_settlements WHERE order_id = $1::uuid`, orderID).Scan(&order.HeldCents, &order.SettledCents)
		if err != nil {
			return err
		}
		var nudged *int64
		err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(nudge_count), 0)::int, MAX(nudged_at_ms)
			FROM delegate_dispatches WHERE order_id = $1::uuid`, orderID).Scan(&order.NudgeCount, &nudged)
		if err != nil {
			return err
		}
		order.NudgedAtMs = nudged
		return nil
	})
	return out, err
}

func str(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
