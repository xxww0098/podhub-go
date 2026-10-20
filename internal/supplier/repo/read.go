package supplierrepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

const memberSQL = `
SELECT m.source_id, COALESCE(s.name, ''), COALESCE(s.country, ''), COALESCE(s.icon, '')
FROM sc_source_members m
JOIN sc_sources s ON s.source_id = m.source_id
WHERE m.user_id = $1 AND m.status = 'active'
ORDER BY m.source_id`

func (r Repo) Me(ctx context.Context, userID int64) (contract.MeData, error) {
	var out contract.MeData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		rows, err := r.loadMembers(ctx, tx, userID)
		if err != nil {
			return err
		}
		out.Sources = rows
		return nil
	})
	return out, err
}

func (r Repo) loadMembers(ctx context.Context, tx pgx.Tx, userID int64) ([]contract.SourceCard, error) {
	rows, err := tx.Query(ctx, memberSQL, userID)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	var out []contract.SourceCard
	for rows.Next() {
		var card contract.SourceCard
		if err := rows.Scan(&card.SourceID, &card.Name, &card.Country, &card.Icon); err != nil {
			return nil, mapDB(err)
		}
		out = append(out, card)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	if len(out) == 0 {
		return nil, fail(403, "forbidden", "账号没有可用的厂家成员身份")
	}
	return out, nil
}

func (r Repo) ListDispatches(ctx context.Context, userID int64, state string, cursor domain.Cursor) (contract.DispatchListData, error) {
	var out contract.DispatchListData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		raw := ""
		if cursor.ID != "" {
			var deadline *string
			if !cursor.NoDeadline {
				deadline = &cursor.Deadline
			}
			raw = domain.EncodeCursor(deadline, cursor.ID)
		}
		rows, err := tx.Query(ctx, listDispatchSQL, state, raw)
		if err != nil {
			return mapDB(err)
		}
		defer rows.Close()
		var page []contract.DispatchRow
		var ids []string
		for rows.Next() {
			var row contract.DispatchRow
			var lines []byte
			var deadline *string
			if err := rows.Scan(&row.DispatchID, &row.DispatchNo, &row.State, &row.PostingNumber, &deadline, &lines); err != nil {
				return mapDB(err)
			}
			row.Deadline = deadline
			row.Lines = parseListLines(lines)
			row.PostingNumber = empty(row.PostingNumber)
			page = append(page, row)
			ids = append(ids, row.DispatchID)
		}
		if err := rows.Err(); err != nil {
			return mapDB(err)
		}
		hasMore := len(page) > 100
		if hasMore {
			page = page[:100]
			ids = ids[:100]
		}
		if err := attachPayouts(ctx, tx, page, ids, "读取"); err != nil {
			return err
		}
		out.Dispatches = page
		if out.Dispatches == nil {
			out.Dispatches = []contract.DispatchRow{}
		}
		out.HasMore = hasMore
		if hasMore && len(page) > 0 {
			last := page[len(page)-1]
			out.Cursor = domain.EncodeCursor(last.Deadline, last.DispatchID)
		}
		return nil
	})
	return out, err
}

const listDispatchSQL = `
SELECT d.dispatch_id::text, d.dispatch_no, d.state,
       COALESCE(d.payload->>'posting_number', ''),
       d.payload->'logistics'->>'shipment_date',
       d.payload->'lines'
FROM delegate_dispatches d
WHERE ($1 = '' OR d.state = $1)
  AND ($2 = ''
       OR (
            (d.payload->'logistics'->>'shipment_date' IS NULL),
            COALESCE(d.payload->'logistics'->>'shipment_date', ''),
            d.dispatch_id::text
          ) > (
            split_part($2, '|', 1) = '1',
            split_part($2, '|', 2),
            split_part($2, '|', 3)
          ))
ORDER BY (d.payload->'logistics'->>'shipment_date' IS NULL) ASC,
         COALESCE(d.payload->'logistics'->>'shipment_date', '') ASC,
         d.dispatch_id ASC
LIMIT 101`

func (r Repo) GetDispatch(ctx context.Context, userID int64, dispatchID string) (contract.DispatchDetail, error) {
	var out contract.DispatchDetail
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		var payload, receipt []byte
		err := tx.QueryRow(ctx, `
			SELECT d.dispatch_id::text, d.dispatch_no, d.state, d.payload, d.receipt,
			       d.created_at_ms, d.updated_at_ms
			FROM delegate_dispatches d
			WHERE d.dispatch_id = $1::uuid
			LIMIT 1`, dispatchID).Scan(&out.DispatchID, &out.DispatchNo, &out.State, &payload, &receipt, &out.CreatedAtMs, &out.UpdatedAtMs)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "not_found", "派发包不存在")
		}
		if err != nil {
			return mapDB(err)
		}
		fillDetail(&out, dispatchID, payload, receipt)
		page := []contract.DispatchRow{{DispatchID: out.DispatchID}}
		if err := attachPayouts(ctx, tx, page, []string{out.DispatchID}, "读取"); err != nil {
			return err
		}
		out.NudgeCount = page[0].NudgeCount
		out.NudgedAtMs = page[0].NudgedAtMs
		out.PayoutCents = page[0].PayoutCents
		out.PayoutState = page[0].PayoutState
		return nil
	})
	return out, err
}

func (r Repo) Wallets(ctx context.Context, userID int64) (contract.WalletListData, error) {
	var out contract.WalletListData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT m.source_id, COALESCE(s.name, ''),
			       COALESCE(w.balance_microfen, 0), COALESCE(w.held_microfen, 0)
			FROM sc_source_members m
			JOIN sc_sources s ON s.source_id = m.source_id
			LEFT JOIN supplier_wallets w ON w.source_id = m.source_id
			WHERE m.user_id = $1 AND m.status = 'active'
			ORDER BY m.source_id`, userID)
		if err != nil {
			return mapDB(err)
		}
		defer rows.Close()
		for rows.Next() {
			var view contract.WalletView
			if err := rows.Scan(&view.SourceID, &view.Name, &view.BalanceMicrofen, &view.HeldMicrofen); err != nil {
				return mapDB(err)
			}
			view.AvailableMicrofen = view.BalanceMicrofen - view.HeldMicrofen
			if view.HeldMicrofen > view.BalanceMicrofen {
				view.AvailableMicrofen = 0
			}
			out.Wallets = append(out.Wallets, view)
		}
		if out.Wallets == nil {
			out.Wallets = []contract.WalletView{}
		}
		return rows.Err()
	})
	return out, err
}

func (r Repo) Withdrawals(ctx context.Context, userID int64) (contract.WithdrawalListData, error) {
	var out contract.WithdrawalListData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		rows, err := loadWithdrawals(ctx, tx, userID, "")
		if err != nil {
			return err
		}
		out.Withdrawals = rows
		return nil
	})
	return out, err
}

func loadWithdrawals(ctx context.Context, tx pgx.Tx, userID int64, onlyID string) ([]contract.WithdrawalView, error) {
	rows, err := tx.Query(ctx, `
		SELECT w.withdrawal_id::text, w.source_id, COALESCE(s.name, ''),
		       w.amount_cents, w.channel, w.account, w.real_name, w.status,
		       w.reference, w.reject_reason, w.requested_at_ms, w.decided_at_ms
		FROM supplier_withdrawals w
		JOIN sc_source_members m
		  ON m.source_id = w.source_id AND m.user_id = $1 AND m.status = 'active'
		JOIN sc_sources s ON s.source_id = w.source_id
		WHERE ($2 = '' OR w.withdrawal_id::text = $2)
		ORDER BY w.requested_at_ms DESC
		LIMIT 50`, userID, onlyID)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	var out []contract.WithdrawalView
	for rows.Next() {
		var view contract.WithdrawalView
		if err := rows.Scan(&view.WithdrawalID, &view.SourceID, &view.Name, &view.AmountCents, &view.Channel,
			&view.Account, &view.RealName, &view.Status, &view.Reference, &view.RejectReason,
			&view.RequestedAtMs, &view.DecidedAtMs); err != nil {
			return nil, mapDB(err)
		}
		if view.Reference != nil && *view.Reference == "" {
			view.Reference = nil
		}
		if view.RejectReason != nil && *view.RejectReason == "" {
			view.RejectReason = nil
		}
		out = append(out, view)
	}
	if out == nil {
		out = []contract.WithdrawalView{}
	}
	return out, rows.Err()
}

func empty(s string) string { return s }

func parseListLines(raw []byte) []contract.DispatchLine {
	if len(raw) == 0 || string(raw) == "null" {
		return []contract.DispatchLine{}
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return []contract.DispatchLine{}
	}
	out := make([]contract.DispatchLine, 0, len(rows))
	for _, row := range rows {
		out = append(out, contract.DispatchLine{
			OfferID: asString(row["offer_id"]), Name: asString(row["name"]), Quantity: asInt32(row["quantity"]),
		})
	}
	return out
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asInt32(v any) int32 {
	switch n := v.(type) {
	case float64:
		return int32(int64(n))
	case json.Number:
		i, _ := n.Int64()
		return int32(i)
	default:
		return 0
	}
}

func strPtr(s string) *string { return &s }

func fillDetail(out *contract.DispatchDetail, dispatchID string, payload, receipt []byte) {
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(payload, &doc)
	out.PostingNumber = jsonString(doc["posting_number"])
	out.SellerNote = jsonString(doc["seller_note"])
	if raw, ok := doc["logistics"]; ok && len(raw) > 0 && raw[0] == '{' {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) == nil {
			view := &contract.LogisticsView{
				Warehouse: jsonStringPtr(fields["warehouse"]), DeliveryMethod: jsonStringPtr(fields["delivery_method"]),
				DeliveryType: jsonStringPtr(fields["delivery_type"]), TplProvider: jsonStringPtr(fields["tpl_provider"]),
				City: jsonStringPtr(fields["city"]), Region: jsonStringPtr(fields["region"]),
				DeliveryDateBegin: jsonStringPtr(fields["delivery_date_begin"]), DeliveryDateEnd: jsonStringPtr(fields["delivery_date_end"]),
				ShipmentDate: jsonStringPtr(fields["shipment_date"]),
			}
			out.Logistics = view
			if view.ShipmentDate != nil {
				out.Deadline = view.ShipmentDate
			}
		}
	}
	out.Lines = parseDetailLines(dispatchID, doc["lines"])
	out.Actions.CanAccept, out.Actions.CanReject, out.Actions.CanShip = domainActions(out.State)
	if len(receipt) > 0 && string(receipt) != "null" {
		var rec map[string]json.RawMessage
		if json.Unmarshal(receipt, &rec) == nil {
			out.Receipt = &contract.ReceiptView{
				TrackingNo: jsonStringPtr(rec["tracking_no"]), Note: jsonStringPtr(rec["note"]),
				Reason: jsonStringPtr(rec["reason"]), AtMs: jsonIntPtr(rec["at_ms"]),
			}
		}
	}
}

func domainActions(state string) (bool, bool, bool) {
	return domain.ActionsView(state)
}

func parseDetailLines(dispatchID string, raw json.RawMessage) []contract.LineDetail {
	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil {
		return []contract.LineDetail{}
	}
	out := make([]contract.LineDetail, 0, len(rows))
	for _, row := range rows {
		line := contract.LineDetail{OfferID: asString(row["offer_id"]), Name: asString(row["name"]), Quantity: asInt32(row["quantity"]), Assets: []contract.AssetLink{}}
		assets, _ := row["assets"].([]any)
		for _, item := range assets {
			obj, _ := item.(map[string]any)
			if obj == nil {
				continue
			}
			id := asString(obj["asset_id"])
			if id == "" {
				continue
			}
			if _, ok := obj["bytes"].(float64); !ok {
				if _, isNum := obj["bytes"].(json.Number); !isNum && obj["bytes"] != nil {
					continue
				}
			}
			line.Assets = append(line.Assets, contract.AssetLink{
				AssetID: id, FileName: asString(obj["file_name"]), SHA256: asString(obj["sha256"]),
				Bytes: int64(asInt32(obj["bytes"])), Mime: asString(obj["mime"]),
				URL: "/api/supplier/dispatches/" + dispatchID + "/assets/" + id,
			})
		}
		out = append(out, line)
	}
	return out
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func jsonStringPtr(raw json.RawMessage) *string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return nil
	}
	return &s
}

func jsonIntPtr(raw json.RawMessage) *int64 {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var n int64
	if json.Unmarshal(raw, &n) != nil {
		return nil
	}
	return &n
}

func attachPayouts(ctx context.Context, tx pgx.Tx, page []contract.DispatchRow, ids []string, verb string) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, payoutSQL, ids)
	if err != nil {
		return mapMoney(err, verb)
	}
	defer rows.Close()
	type pay struct {
		nudge        int32
		nudged       *int64
		frozen       *int64
		state        *string
		quoted, miss int64
	}
	found := map[string]pay{}
	for rows.Next() {
		var id string
		var item pay
		if err := rows.Scan(&id, &item.nudge, &item.nudged, &item.frozen, &item.state, &item.quoted, &item.miss); err != nil {
			return mapMoney(err, verb)
		}
		found[id] = item
	}
	if err := rows.Err(); err != nil {
		return mapMoney(err, verb)
	}
	for i := range page {
		item, ok := found[page[i].DispatchID]
		if !ok {
			continue
		}
		page[i].NudgeCount = item.nudge
		page[i].NudgedAtMs = item.nudged
		if item.frozen != nil {
			page[i].PayoutCents = item.frozen
			page[i].PayoutState = item.state
			continue
		}
		if item.miss == 0 && item.quoted > 0 {
			page[i].PayoutCents = &item.quoted
		}
	}
	return nil
}

const payoutSQL = `
SELECT d.dispatch_id::text,
       d.nudge_count::int,
       d.nudged_at_ms,
       s.amount_cents,
       s.state,
       COALESCE((
           SELECT SUM(GREATEST(COALESCE(l.quantity, 1), 1) * priced.unit_cents)
           FROM jsonb_to_recordset(COALESCE(d.payload->'lines', '[]'::jsonb))
                AS l(offer_id text, quantity int)
           JOIN LATERAL (
               SELECT COALESCE(o.cost_cents, 0) + COALESCE(o.shipping_cost_cents, 0) AS unit_cents
               FROM sc_skus k
               JOIN sc_source_offers o ON o.sku_id = k.sku_id AND o.source_id = d.source_id
               WHERE k.platform_code = l.offer_id
               LIMIT 1
           ) priced ON priced.unit_cents > 0
       ), 0)::bigint,
       (
           SELECT COUNT(*)
           FROM jsonb_to_recordset(COALESCE(d.payload->'lines', '[]'::jsonb))
                AS l(offer_id text, quantity int)
           WHERE NOT EXISTS (
               SELECT 1
               FROM sc_skus k
               JOIN sc_source_offers o ON o.sku_id = k.sku_id AND o.source_id = d.source_id
               WHERE k.platform_code = l.offer_id
                 AND COALESCE(o.cost_cents, 0) + COALESCE(o.shipping_cost_cents, 0) > 0
           )
       )::bigint
FROM delegate_dispatches d
LEFT JOIN delegate_settlements s ON s.dispatch_id = d.dispatch_id
WHERE d.dispatch_id = ANY($1::uuid[])`
