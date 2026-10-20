package delegaterepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func (r Repo) loadDetail(ctx context.Context, orderID string) (json.RawMessage, error) {
	if r.pool == nil {
		return nil, contract.Internal()
	}
	var body json.RawMessage
	var fnErr error
	err := db.InTx(ctx, r.pool, db.Staff(), func(tx pgx.Tx) error {
		body, fnErr = detail(ctx, tx, orderID)
		return fnErr
	})
	if err == nil {
		return body, nil
	}
	if fnErr != nil {
		return nil, err
	}
	return nil, mapDB(err)
}

func detail(ctx context.Context, tx pgx.Tx, orderID string) (json.RawMessage, error) {
	var order struct {
		OrderID, StoreID, Posting, Note, State string
		Cancel                                 bool
		Snapshot, Logistics                    []byte
		Created, Updated                       int64
	}
	err := tx.QueryRow(ctx, `
		SELECT order_id::text, store_id::text, posting_number, seller_note, state, cancel_requested,
		       posting_snapshot, logistics, created_at_ms, updated_at_ms
		FROM delegate_orders WHERE order_id = $1::uuid`, orderID).Scan(
		&order.OrderID, &order.StoreID, &order.Posting, &order.Note, &order.State, &order.Cancel,
		&order.Snapshot, &order.Logistics, &order.Created, &order.Updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, contract.NotFound("委托单不存在")
	}
	if err != nil {
		return nil, mapDB(err)
	}
	var held, settled int64
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents) FILTER (WHERE state = 'held'), 0)::bigint,
		       COALESCE(SUM(amount_cents) FILTER (WHERE state = 'settled'), 0)::bigint
		FROM delegate_settlements WHERE order_id = $1::uuid`, orderID).Scan(&held, &settled)
	var nudge int32
	var nudged *int64
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(nudge_count), 0)::int, MAX(nudged_at_ms)
		FROM delegate_dispatches WHERE order_id = $1::uuid`, orderID).Scan(&nudge, &nudged)

	lineRows, err := tx.Query(ctx, `
		SELECT l.line_id::text, l.offer_id, l.sku, l.name, l.quantity,
		       s.source_id, COALESCE(s.name, ''), COALESCE(s.country, ''), COALESCE(s.icon, ''),
		       (SELECT d.state FROM delegate_dispatches d
		         WHERE d.order_id = l.order_id
		           AND d.payload->'lines' @> to_jsonb(jsonb_build_array(jsonb_build_object('line_id', l.line_id::text)))
		         ORDER BY d.created_at_ms DESC, d.dispatch_id DESC LIMIT 1)
		FROM delegate_order_lines l
		LEFT JOIN delegate_bindings b ON b.binding_id = l.binding_id
		LEFT JOIN sc_sources s ON s.source_id = b.source_id
		WHERE l.order_id = $1::uuid
		ORDER BY l.line_id`, orderID)
	if err != nil {
		return nil, mapDB(err)
	}
	defer lineRows.Close()
	var lines []any
	for lineRows.Next() {
		var id, offer, name, sname, country, icon string
		var sku int64
		var qty int32
		var packet *string
		var sourceID *string
		if err := lineRows.Scan(&id, &offer, &sku, &name, &qty, &sourceID, &sname, &country, &icon, &packet); err != nil {
			return nil, mapDB(err)
		}
		row := map[string]any{
			"lineId": id, "offerId": offer, "sku": sku, "name": name, "quantity": qty,
		}
		if sourceID != nil && *sourceID != "" {
			row["source"] = map[string]any{"sourceId": *sourceID, "name": sname, "country": country, "icon": icon}
		}
		if packet != nil && *packet != "" {
			row["packetState"] = *packet
		}
		lines = append(lines, row)
	}
	if lines == nil {
		lines = []any{}
	}

	ledRows, err := tx.Query(ctx, `
		SELECT d.dispatch_id::text, d.dispatch_no, d.source_id,
		       COALESCE(s.name, ''), COALESCE(s.country, ''), COALESCE(s.icon, ''),
		       d.state, d.attempted_by, d.receipt,
		       COALESCE(jsonb_array_length(d.payload->'lines'), 0)::bigint,
		       d.created_at_ms, d.updated_at_ms
		FROM delegate_dispatches d
		LEFT JOIN sc_sources s ON s.source_id = d.source_id
		WHERE d.order_id = $1::uuid
		ORDER BY d.created_at_ms ASC, d.dispatch_id ASC`, orderID)
	if err != nil {
		return nil, mapDB(err)
	}
	defer ledRows.Close()
	var ledger []any
	for ledRows.Next() {
		var id, no, source, name, country, icon, state, by string
		var receipt []byte
		var count, created, updated int64
		if err := ledRows.Scan(&id, &no, &source, &name, &country, &icon, &state, &by, &receipt, &count, &created, &updated); err != nil {
			return nil, mapDB(err)
		}
		row := map[string]any{
			"dispatchId": id, "dispatchNo": no,
			"source": map[string]any{"sourceId": source, "name": name, "country": country, "icon": icon},
			"state":  state, "attemptedBy": by, "lineCount": count,
			"createdAtMs": created, "updatedAtMs": updated,
		}
		if view := receiptObject(receipt); view != nil {
			row["receipt"] = view
		}
		ledger = append(ledger, row)
	}
	if ledger == nil {
		ledger = []any{}
	}
	orderView := map[string]any{
		"orderId": order.OrderID, "storeId": order.StoreID, "postingNumber": order.Posting,
		"sellerNote": order.Note, "state": order.State, "cancelRequested": order.Cancel,
		"postingSnapshot": json.RawMessage(order.Snapshot),
		"lines":           lines, "createdAtMs": order.Created, "updatedAtMs": order.Updated,
		"heldCents": held, "settledCents": settled, "nudgeCount": nudge,
	}
	if len(order.Logistics) > 0 && string(order.Logistics) != "null" {
		orderView["logistics"] = json.RawMessage(order.Logistics)
	}
	if nudged != nil {
		orderView["nudgedAtMs"] = *nudged
	}
	body, err := json.Marshal(map[string]any{"data": map[string]any{"order": map[string]any{
		"order": orderView, "ledger": ledger,
	}}})
	if err != nil {
		return nil, contract.Internal()
	}
	return body, nil
}

func receiptObject(raw []byte) map[string]any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return nil
	}
	view := domain.ReceiptView(obj)
	if view == nil {
		return nil
	}
	out := map[string]any{}
	if view.TrackingNo != "" {
		out["trackingNo"] = view.TrackingNo
	}
	if view.Note != "" {
		out["note"] = view.Note
	}
	if view.Reason != "" {
		out["reason"] = view.Reason
	}
	if view.RecordedBy != "" {
		out["recordedBy"] = view.RecordedBy
	}
	if view.AtMs != nil {
		out["atMs"] = *view.AtMs
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
