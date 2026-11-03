package supplierrepo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

func (r Repo) Me(ctx context.Context, userID int64) (contract.MeData, error) {
	var out contract.MeData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		rows, err := loadFulfillerSources(ctx, tx)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			var member bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.sc_factory_members WHERE user_id=$1 AND status='active')`, userID).Scan(&member); err != nil {
				return mapDB(err)
			}
			if !member {
				return fail(403, "forbidden", "账号不是有效的工厂成员")
			}
		}
		out.Sources = rows
		return nil
	})
	return out, err
}

func loadFulfillerSources(ctx context.Context, tx pgx.Tx) ([]contract.SourceCard, error) {
	rows, err := tx.Query(ctx, `SELECT source_id, name, country, icon FROM supplier_fulfiller_sources()`)
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
	if out == nil {
		out = []contract.SourceCard{}
	}
	return out, nil
}

func authorizeWorkspace(ctx context.Context, tx pgx.Tx, sourceID string) error {
	sources, err := loadFulfillerSources(ctx, tx)
	if err != nil {
		return err
	}
	if len(sources) == 0 {
		return fail(403, "forbidden", "账号没有可用的履约授权或历史派单")
	}
	for _, source := range sources {
		if source.SourceID == sourceID {
			return nil
		}
	}
	return fail(404, "not_found", "工厂工作空间不存在")
}

const dispatchPageSize = 20

func (r Repo) ListDispatches(ctx context.Context, userID int64, sourceID, view, search, status, reason string, cursor domain.Cursor, now time.Time) (contract.DispatchListData, error) {
	var out contract.DispatchListData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if err := authorizeWorkspace(ctx, tx, sourceID); err != nil {
			return err
		}
		page, deadlines, err := queryDispatches(ctx, tx, sourceID, view, search, status, reason, cursor, now, dispatchPageSize+1)
		if err != nil {
			return err
		}
		hasMore := len(page) > dispatchPageSize
		if hasMore {
			page = page[:dispatchPageSize]
		}
		out.Dispatches = page
		out.HasMore = hasMore
		if hasMore && len(page) > 0 {
			last := page[len(page)-1]
			var due *string
			if deadlines[len(page)-1] != nil {
				formatted := deadlines[len(page)-1].UTC().Format(time.RFC3339Nano)
				due = &formatted
			}
			out.Cursor = domain.EncodeCursor(due, last.DispatchID)
		}
		return nil
	})
	return out, err
}

func (r Repo) Dashboard(ctx context.Context, userID int64, sourceID string, now time.Time) (contract.DashboardData, error) {
	var out contract.DashboardData
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if err := authorizeWorkspace(ctx, tx, sourceID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, dashboardSQL, sourceID, now)
		if err != nil {
			return mapDB(err)
		}
		defer rows.Close()
		out.UrgentOrders = []contract.DispatchRow{}
		var ids []string
		for rows.Next() {
			var id, number, state, deadline *string
			var posting string
			var lines []byte
			if err := rows.Scan(&out.Counts.Pending, &out.Counts.Producing, &out.Counts.Urgent, &out.Counts.Shipped,
				&id, &number, &state, &posting, &deadline, &lines); err != nil {
				return mapDB(err)
			}
			if id == nil {
				continue
			}
			lineViews, thumbnail := parseListLines(*id, lines)
			out.UrgentOrders = append(out.UrgentOrders, contract.DispatchRow{
				DispatchID: *id, DispatchNo: *number, State: *state,
				PostingNumber: posting, Deadline: deadline, Lines: lineViews, ThumbnailURL: thumbnail,
			})
			ids = append(ids, *id)
		}
		if err := rows.Err(); err != nil {
			return mapDB(err)
		}
		rows.Close()
		return attachPayouts(ctx, tx, out.UrgentOrders, ids, "读取")
	})
	return out, err
}

func queryDispatches(ctx context.Context, tx pgx.Tx, sourceID, view, search, status, reason string, cursor domain.Cursor, now time.Time, limit int) ([]contract.DispatchRow, []*time.Time, error) {
	var cursorDue *time.Time
	if cursor.ID != "" && !cursor.NoDeadline {
		due, err := time.Parse(time.RFC3339Nano, cursor.Deadline)
		if err != nil {
			return nil, nil, fail(400, "validation", "分页游标无效")
		}
		cursorDue = &due
	}
	rows, err := tx.Query(ctx, listDispatchSQL, sourceID, now, view, search, status, reason, cursor.ID, cursor.NoDeadline, cursorDue, limit)
	if err != nil {
		return nil, nil, mapDB(err)
	}
	defer rows.Close()
	page := []contract.DispatchRow{}
	deadlines := []*time.Time{}
	ids := []string{}
	for rows.Next() {
		var row contract.DispatchRow
		var lines []byte
		var due *time.Time
		if err := rows.Scan(&row.DispatchID, &row.DispatchNo, &row.State, &row.PostingNumber, &row.Deadline, &lines, &due); err != nil {
			return nil, nil, mapDB(err)
		}
		row.Lines, row.ThumbnailURL = parseListLines(row.DispatchID, lines)
		page = append(page, row)
		deadlines = append(deadlines, due)
		ids = append(ids, row.DispatchID)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, mapDB(err)
	}
	rows.Close()
	if len(page) > dispatchPageSize {
		ids = ids[:dispatchPageSize]
	}
	if err := attachPayouts(ctx, tx, page, ids, "读取"); err != nil {
		return nil, nil, err
	}
	return page, deadlines, nil
}

// Only valid ISO dates are cast; upstream payloads can contain malformed dates.
const dispatchBaseSQL = `
WITH source_rows AS (
  SELECT d.dispatch_id, d.dispatch_no, d.state, d.payload, d.nudge_count,
         d.payload->'logistics'->>'shipment_date' AS deadline
  FROM delegate_dispatches d
  WHERE d.source_id = $1 AND d.state IN ('dispatched', 'accepted', 'shipped')
),
timed AS (
  SELECT *,
    CASE
      WHEN deadline ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           AND pg_input_is_valid(deadline, 'date')
        THEN (deadline || 'T23:59:59Z')::timestamptz
      WHEN deadline ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
           AND pg_input_is_valid(deadline, 'timestamp with time zone')
        THEN deadline::timestamptz
      ELSE NULL
    END AS due_at
  FROM source_rows
),
projected AS (
  SELECT *, state IN ('dispatched', 'accepted')
            AND (nudge_count > 0 OR due_at <= $2::timestamptz + interval '12 hours') AS urgent
  FROM timed
)
`

const dashboardSQL = dispatchBaseSQL + `,
totals AS (
  SELECT count(*) FILTER (WHERE state = 'dispatched') AS pending,
         count(*) FILTER (WHERE state = 'accepted') AS producing,
         count(*) FILTER (WHERE urgent) AS urgent_count,
         count(*) FILTER (WHERE state = 'shipped') AS shipped
  FROM projected
),
top_urgent AS (
  SELECT * FROM projected WHERE urgent ORDER BY due_at ASC NULLS LAST, dispatch_id ASC LIMIT 3
)
SELECT totals.pending, totals.producing, totals.urgent_count, totals.shipped,
       u.dispatch_id::text, u.dispatch_no, u.state, COALESCE(u.payload->>'posting_number', ''),
       u.deadline, u.payload->'lines'
FROM totals LEFT JOIN top_urgent u ON TRUE
ORDER BY u.due_at ASC NULLS LAST, u.dispatch_id ASC`

const listDispatchSQL = dispatchBaseSQL + `
SELECT dispatch_id::text, dispatch_no, state, COALESCE(payload->>'posting_number', ''),
       deadline, payload->'lines', due_at
FROM projected
WHERE (($3 = 'pending' AND state = 'dispatched')
    OR ($3 = 'producing' AND state = 'accepted')
    OR ($3 = 'urgent' AND urgent)
    OR ($3 = 'shipped' AND state = 'shipped'))
  AND ($4 = '' OR strpos(lower(dispatch_no), lower($4)) > 0
       OR strpos(lower(COALESCE(payload->>'posting_number', '')), lower($4)) > 0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(payload->'lines') = 'array' THEN payload->'lines' ELSE '[]'::jsonb END
         ) AS line WHERE strpos(lower(COALESCE(line->>'name', '')), lower($4)) > 0
       ))
  AND ($5 = '' OR state = $5)
  AND ($6 = '' OR ($6 = 'nudge' AND nudge_count > 0)
       OR ($6 = 'deadline' AND due_at <= $2::timestamptz + interval '12 hours'))
  AND ($7::text = '' OR (due_at IS NULL, COALESCE(due_at, 'infinity'::timestamptz), dispatch_id) >
      ($8::boolean, COALESCE($9::timestamptz, 'infinity'::timestamptz), NULLIF($7, '')::uuid))
ORDER BY due_at ASC NULLS LAST, dispatch_id ASC
LIMIT $10`

func (r Repo) GetDispatch(ctx context.Context, userID int64, dispatchID string) (contract.DispatchDetail, error) {
	var out contract.DispatchDetail
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := loadFulfillerSources(ctx, tx); err != nil {
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

func parseListLines(dispatchID string, raw []byte) ([]contract.DispatchLine, *string) {
	if len(raw) == 0 || string(raw) == "null" {
		return []contract.DispatchLine{}, nil
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return []contract.DispatchLine{}, nil
	}
	out := make([]contract.DispatchLine, 0, len(rows))
	var thumbnail *string
	for _, row := range rows {
		out = append(out, contract.DispatchLine{
			OfferID: asString(row["offer_id"]), Name: asString(row["name"]), Quantity: asInt32(row["quantity"]),
		})
		if thumbnail != nil {
			continue
		}
		assets, _ := row["assets"].([]any)
		for _, item := range assets {
			asset, _ := item.(map[string]any)
			mime, id, key := asString(asset["mime"]), asString(asset["asset_id"]), asString(asset["object_key"])
			if mime != "image/jpeg" && mime != "image/png" && mime != "image/webp" {
				continue
			}
			canonical, err := domain.ParseUUID(id)
			if err != nil || canonical != id || strings.TrimSpace(key) == "" {
				continue
			}
			if _, ok := asset["bytes"].(float64); !ok && asset["bytes"] != nil {
				continue
			}
			url := "/api/supplier/dispatches/" + dispatchID + "/assets/" + id
			thumbnail = &url
			break
		}
	}
	return out, thumbnail
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
       q.total_cents,
       q.missing_count::bigint
FROM delegate_dispatches d
LEFT JOIN delegate_settlements s ON s.dispatch_id = d.dispatch_id
CROSS JOIN LATERAL supplier_dispatch_quote(d.dispatch_id) q
WHERE d.dispatch_id = ANY($1::uuid[])`
