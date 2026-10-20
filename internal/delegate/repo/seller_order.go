package delegaterepo

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
)

func promote(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, offers []string, bindingID string, auto bool, nowMS int64) ([]string, error) {
	if len(offers) == 0 {
		return nil, nil
	}
	if _, err := tx.Exec(ctx, `
		SELECT o.order_id
		  FROM delegate_orders o
		  JOIN delegate_order_lines l ON l.order_id = o.order_id
		 WHERE o.org_id = $1 AND o.store_id = $2::uuid
		   AND o.state IN (`+openStates+`)
		   AND l.offer_id = ANY($3)
		 ORDER BY o.order_id, l.line_id
		   FOR UPDATE OF o`, orgID, storeID, offers); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		UPDATE delegate_order_lines l
		   SET binding_id = $4::uuid,
		       last_rejected_source_id = CASE
		           WHEN l.last_rejected_source_id IS NOT NULL
		            AND l.last_rejected_source_id IS DISTINCT FROM (
		                SELECT b.source_id FROM delegate_bindings b WHERE b.binding_id = $4::uuid
		            )
		           THEN NULL
		           ELSE l.last_rejected_source_id
		       END
		  FROM delegate_orders o
		 WHERE o.order_id = l.order_id
		   AND o.org_id = $1 AND o.store_id = $2::uuid
		   AND o.state IN (`+openStates+`)
		   AND l.offer_id = ANY($3)
		 RETURNING l.order_id::text`, orgID, storeID, offers, bindingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]struct{}{}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	sort.Strings(ids)
	if err := recomputeAll(ctx, tx, ids, nowMS); err != nil {
		return nil, err
	}
	if auto {
		for _, id := range ids {
			if err := dispatchReady(ctx, tx, orgID, id, nowMS); err != nil {
				return nil, err
			}
		}
	}
	return ids, nil
}

func recomputeStore(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, auto bool, nowMS int64) error {
	rows, err := tx.Query(ctx, `
		SELECT order_id::text FROM delegate_orders
		 WHERE org_id = $1 AND store_id = $2::uuid AND state IN (`+openStates+`)
		 ORDER BY order_id
		   FOR UPDATE`, orgID, storeID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if err := recomputeAll(ctx, tx, ids, nowMS); err != nil {
		return err
	}
	if auto {
		for _, id := range ids {
			if err := dispatchReady(ctx, tx, orgID, id, nowMS); err != nil {
				return err
			}
		}
	}
	return nil
}

// recomputeAll reads ready and packet_state for every order once, then
// applies ComputeOrderState and the same UPDATE in the caller's id order.
// dispatchReady still runs after those writes, one order at a time, because
// it reads the state this UPDATE just stored.
func recomputeAll(ctx context.Context, tx pgx.Tx, ids []string, nowMS int64) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `
		SELECT l.order_id::text,
		       (b.active IS TRUE AND EXISTS (
		           SELECT 1 FROM delegate_assets a
		            WHERE a.binding_id = b.binding_id AND a.verified_at_ms IS NOT NULL
		       )) AS ready,
		       (SELECT d.state FROM delegate_dispatches d
		         WHERE d.order_id = l.order_id
		           AND d.payload->'lines' @> to_jsonb(jsonb_build_array(jsonb_build_object('line_id', l.line_id::text)))
		         ORDER BY d.created_at_ms DESC, d.dispatch_id DESC
		         LIMIT 1) AS packet_state
		  FROM delegate_order_lines l
		  LEFT JOIN delegate_bindings b ON b.binding_id = l.binding_id
		 WHERE l.order_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return err
	}
	grouped := make(map[string][]domain.Line, len(ids))
	for _, id := range ids {
		grouped[id] = nil
	}
	for rows.Next() {
		var id string
		var ready bool
		var packet *string
		if err := rows.Scan(&id, &ready, &packet); err != nil {
			rows.Close()
			return err
		}
		line := domain.Line{Ready: &ready}
		if packet != nil {
			line.Packet = *packet
		}
		grouped[id] = append(grouped[id], line)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		state := domain.ComputeOrderState(grouped[id])
		if _, err := tx.Exec(ctx, `
			UPDATE delegate_orders SET state = $2, updated_at_ms = $3
			 WHERE order_id = $1::uuid AND state NOT IN ('done', 'cancelled')`, id, state, nowMS); err != nil {
			return err
		}
	}
	return nil
}

func recompute(ctx context.Context, tx pgx.Tx, orderID string, nowMS int64) error {
	rows, err := tx.Query(ctx, `
		SELECT (b.active IS TRUE AND EXISTS (
		           SELECT 1 FROM delegate_assets a
		            WHERE a.binding_id = b.binding_id AND a.verified_at_ms IS NOT NULL
		       )) AS ready,
		       (SELECT d.state FROM delegate_dispatches d
		         WHERE d.order_id = l.order_id
		           AND d.payload->'lines' @> to_jsonb(jsonb_build_array(jsonb_build_object('line_id', l.line_id::text)))
		         ORDER BY d.created_at_ms DESC, d.dispatch_id DESC
		         LIMIT 1) AS packet_state
		  FROM delegate_order_lines l
		  LEFT JOIN delegate_bindings b ON b.binding_id = l.binding_id
		 WHERE l.order_id = $1::uuid`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var lines []domain.Line
	for rows.Next() {
		var ready bool
		var packet *string
		if err := rows.Scan(&ready, &packet); err != nil {
			return err
		}
		line := domain.Line{Ready: &ready}
		if packet != nil {
			line.Packet = *packet
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	state := domain.ComputeOrderState(lines)
	_, err = tx.Exec(ctx, `
		UPDATE delegate_orders SET state = $2, updated_at_ms = $3
		 WHERE order_id = $1::uuid AND state NOT IN ('done', 'cancelled')`, orderID, state, nowMS)
	return err
}

func dispatchReady(ctx context.Context, tx pgx.Tx, orgID int64, orderID string, nowMS int64) error {
	var posting, note, state string
	var logistics []byte
	var cancel bool
	err := tx.QueryRow(ctx, `
		SELECT posting_number, seller_note, logistics, state, cancel_requested
		  FROM delegate_orders WHERE order_id = $1::uuid
		   FOR UPDATE`, orderID).Scan(&posting, &note, &logistics, &state, &cancel)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.NotFound("委托单不存在")
	}
	if err != nil {
		return err
	}
	if cancel || (state != "ready" && state != "dispatched" && state != "in_production") || len(logistics) == 0 || string(logistics) == "null" {
		return nil
	}
	rows, err := tx.Query(ctx, `
		SELECT l.line_id::text, l.offer_id, l.name, l.quantity, s.source_id,
		       COALESCE((SELECT jsonb_agg(jsonb_build_object(
		                   'asset_id', a.asset_id::text,
		                   'file_name', a.file_name,
		                   'object_key', a.object_key,
		                   'sha256', a.sha256,
		                   'bytes', a.bytes,
		                   'mime', a.mime
		                 ) ORDER BY a.position, a.created_at_ms)
		            FROM delegate_assets a
		           WHERE a.binding_id = b.binding_id AND a.verified_at_ms IS NOT NULL), '[]'::jsonb)
		  FROM delegate_order_lines l
		  JOIN delegate_bindings b ON b.binding_id = l.binding_id AND b.active IS TRUE
		   AND EXISTS (SELECT 1 FROM delegate_assets va WHERE va.binding_id = b.binding_id AND va.verified_at_ms IS NOT NULL)
		  JOIN sc_sources s ON s.source_id = b.source_id
		 WHERE l.order_id = $1::uuid
		   AND NOT EXISTS (
		         SELECT 1 FROM delegate_dispatches d
		          WHERE d.order_id = l.order_id
		            AND d.state IN ('dispatched', 'accepted', 'shipped')
		            AND d.payload->'lines' @> to_jsonb(jsonb_build_array(jsonb_build_object('line_id', l.line_id::text))))
		   AND (l.last_rejected_source_id IS NULL OR l.last_rejected_source_id <> b.source_id)`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type line struct {
		id, offer, name, source string
		qty                     int32
		assets                  json.RawMessage
	}
	grouped := map[string][]line{}
	for rows.Next() {
		var row line
		if err := rows.Scan(&row.id, &row.offer, &row.name, &row.qty, &row.source, &row.assets); err != nil {
			return err
		}
		grouped[row.source] = append(grouped[row.source], row)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if len(grouped) == 0 {
		return nil
	}
	sources := make([]string, 0, len(grouped))
	for source := range grouped {
		sources = append(sources, source)
	}
	sort.Strings(sources)
	for _, source := range sources {
		lines := grouped[source]
		payloadLines := make([]any, 0, len(lines))
		seenAsset := map[string]struct{}{}
		var assetIDs []string
		for _, line := range lines {
			var assets any
			if err := json.Unmarshal(line.assets, &assets); err != nil {
				return err
			}
			payloadLines = append(payloadLines, map[string]any{
				"line_id": line.id, "offer_id": line.offer, "name": line.name, "quantity": line.qty, "assets": assets,
			})
			var items []struct {
				AssetID string `json:"asset_id"`
			}
			_ = json.Unmarshal(line.assets, &items)
			for _, item := range items {
				if item.AssetID == "" {
					continue
				}
				if _, ok := seenAsset[item.AssetID]; ok {
					continue
				}
				seenAsset[item.AssetID] = struct{}{}
				assetIDs = append(assetIDs, item.AssetID)
			}
		}
		payload, err := json.Marshal(map[string]any{
			"posting_number": posting, "seller_note": note, "logistics": json.RawMessage(logistics), "lines": payloadLines,
		})
		if err != nil {
			return err
		}
		dispatchNo, err := domain.NewDispatchNo()
		if err != nil {
			return err
		}
		var dispatchID string
		err = tx.QueryRow(ctx, `
			INSERT INTO delegate_dispatches
			    (org_id, order_id, source_id, dispatch_no, payload, state, attempted_by, created_at_ms, updated_at_ms)
			VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 'dispatched', 'auto', $6, $6)
			ON CONFLICT (order_id, source_id) WHERE state = 'dispatched' DO NOTHING
			RETURNING dispatch_id::text`, orgID, orderID, source, dispatchNo, string(payload), nowMS).Scan(&dispatchID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if err := insertDispatchAssets(ctx, tx, dispatchID, assetIDs, orgID); err != nil {
			return err
		}
	}
	return recompute(ctx, tx, orderID, nowMS)
}

func insertDispatchAssets(ctx context.Context, tx pgx.Tx, dispatchID string, assetIDs []string, orgID int64) error {
	if len(assetIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO delegate_dispatch_assets (dispatch_id, asset_id, org_id)
		SELECT $1::uuid, x, $3
		  FROM unnest($2::uuid[]) AS x
		ON CONFLICT (dispatch_id, asset_id) DO NOTHING`, dispatchID, assetIDs, orgID)
	return err
}

// OrderQuery is contract.OrderQuery.
type OrderQuery = contract.OrderQuery

// ListOrders is the keyset page. The caller already short-circuits an empty store cut.
func (r Repo) ListOrders(ctx context.Context, orgID int64, q OrderQuery) (orders []contract.Order, hasNext bool, cursor string, err error) {
	err = r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		var stores []string
		if !q.AllStores {
			stores = q.Stores
		}
		var cursorID any
		if q.CursorOrderID != "" {
			cursorID = q.CursorOrderID
		}
		rows, err := tx.Query(ctx, `
			SELECT `+orderCols+`
			  FROM delegate_orders
			 WHERE org_id = $1
			   AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))
			   AND ($3 = '' OR state = $3)
			   AND ($4::bigint IS NULL OR created_at_ms < $4 OR (created_at_ms = $4 AND order_id < $5::uuid))
			 ORDER BY created_at_ms DESC, order_id DESC
			 LIMIT $6`, orgID, stores, q.State, q.CursorMS, cursorID, q.Limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		var page []orderHead
		for rows.Next() {
			head, err := scanHead(rows)
			if err != nil {
				return err
			}
			page = append(page, head)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		rows.Close()
		hasNext = int64(len(page)) > q.Limit
		if hasNext {
			page = page[:q.Limit]
		}
		orders, err = hydrate(ctx, tx, page)
		if err != nil {
			return err
		}
		if hasNext && len(page) > 0 {
			last := page[len(page)-1]
			cursor = domain.EncodeCursor(last.CreatedAtMS, last.OrderID)
		}
		return nil
	})
	if orders == nil {
		orders = []contract.Order{}
	}
	return orders, hasNext, cursor, err
}

// GetOrder loads one order the actor can see. Missing and invisible are both not found.
func (r Repo) GetOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string) (contract.Order, error) {
	var out contract.Order
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		head, err := loadOrderActor(ctx, tx, orgID, userID, canManage, orderID)
		if err != nil {
			return err
		}
		rows, err := hydrate(ctx, tx, []orderHead{head})
		if err != nil {
			return err
		}
		out = rows[0]
		return nil
	})
	return out, err
}

type orderHead struct {
	OrderID, StoreID, PostingNumber, SellerNote, State string
	Cancel                                             bool
	Snapshot, Logistics                                []byte
	CreatedAtMS, UpdatedAtMS                           int64
}

func scanHead(row interface{ Scan(...any) error }) (orderHead, error) {
	var head orderHead
	err := row.Scan(&head.OrderID, &head.StoreID, &head.PostingNumber, &head.SellerNote, &head.State, &head.Cancel, &head.Snapshot, &head.Logistics, &head.CreatedAtMS, &head.UpdatedAtMS)
	return head, err
}

func loadOrderActor(ctx context.Context, tx pgx.Tx, orgID, userID int64, canManage bool, orderID string) (orderHead, error) {
	row := tx.QueryRow(ctx, `
		SELECT `+orderCols+`
		  FROM delegate_orders o
		 WHERE o.org_id = $1 AND o.order_id = $2::uuid
		   AND EXISTS (
		         SELECT 1 FROM organization_stores s
		           JOIN organization_members m ON m.org_id = s.org_id AND m.user_id = $3 AND `+usableMember+`
		          WHERE s.org_id = o.org_id AND s.uuid = o.store_id AND s.deleted_at_ms IS NULL
		            AND ($4 OR s.assignee_membership_id = m.id))
		 LIMIT 1`, orgID, orderID, userID, canManage)
	head, err := scanHead(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return orderHead{}, contract.NotFound("委托单不存在")
	}
	return head, err
}

func hydrate(ctx context.Context, tx pgx.Tx, heads []orderHead) ([]contract.Order, error) {
	if len(heads) == 0 {
		return []contract.Order{}, nil
	}
	ids := make([]string, len(heads))
	for i, head := range heads {
		ids[i] = head.OrderID
	}
	lines, err := loadLines(ctx, tx, ids)
	if err != nil {
		return nil, err
	}
	billing, err := loadBilling(ctx, tx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]contract.Order, 0, len(heads))
	for _, head := range heads {
		money := billing[head.OrderID]
		orderLines := lines[head.OrderID]
		if orderLines == nil {
			orderLines = []contract.OrderLine{}
		}
		order := contract.Order{
			OrderID: head.OrderID, StoreID: head.StoreID, PostingNumber: head.PostingNumber,
			SellerNote: head.SellerNote, State: head.State, CancelRequested: head.Cancel,
			PostingSnapshot: domain.ProjectSnapshot(head.Snapshot),
			Lines:           orderLines,
			CreatedAtMS:     head.CreatedAtMS, UpdatedAtMS: head.UpdatedAtMS,
			HeldCents: money.held, SettledCents: money.settled, NudgeCount: money.nudges, NudgedAtMS: money.nudged,
		}
		if len(head.Logistics) > 0 && string(head.Logistics) != "null" {
			order.Logistics = json.RawMessage(head.Logistics)
		}
		out = append(out, order)
	}
	return out, nil
}

func loadLines(ctx context.Context, tx pgx.Tx, ids []string) (map[string][]contract.OrderLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.order_id::text, l.line_id::text, l.offer_id, l.sku, l.name, l.quantity,
		       s.source_id, s.name, s.country, s.icon,
		       (SELECT d.state FROM delegate_dispatches d
		         WHERE d.order_id = l.order_id
		           AND d.payload->'lines' @> to_jsonb(jsonb_build_array(jsonb_build_object('line_id', l.line_id::text)))
		         ORDER BY d.created_at_ms DESC, d.dispatch_id DESC
		         LIMIT 1)
		  FROM delegate_order_lines l
		  LEFT JOIN delegate_bindings b ON b.binding_id = l.binding_id
		  LEFT JOIN sc_sources s ON s.source_id = b.source_id
		 WHERE l.order_id = ANY($1::uuid[])
		 ORDER BY l.line_id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]contract.OrderLine{}
	for rows.Next() {
		var orderID string
		var line contract.OrderLine
		var sourceID, name, country, icon, packet *string
		if err := rows.Scan(&orderID, &line.LineID, &line.OfferID, &line.SKU, &line.Name, &line.Quantity, &sourceID, &name, &country, &icon, &packet); err != nil {
			return nil, err
		}
		if sourceID != nil {
			src := contract.Source{SourceID: *sourceID}
			if name != nil {
				src.Name = *name
			}
			if country != nil {
				src.Country = *country
			}
			if icon != nil {
				src.Icon = *icon
			}
			line.Source = &src
		}
		line.PacketState = packet
		out[orderID] = append(out[orderID], line)
	}
	return out, rows.Err()
}

type money struct {
	held, settled int64
	nudges        int32
	nudged        *int64
}

func loadBilling(ctx context.Context, tx pgx.Tx, ids []string) (map[string]money, error) {
	out := map[string]money{}
	for _, id := range ids {
		out[id] = money{}
	}
	rows, err := tx.Query(ctx, `
		SELECT order_id::text,
		       COALESCE(SUM(amount_cents) FILTER (WHERE state = 'held'), 0)::bigint,
		       COALESCE(SUM(amount_cents) FILTER (WHERE state = 'settled'), 0)::bigint
		  FROM delegate_settlements
		 WHERE order_id = ANY($1::uuid[])
		 GROUP BY order_id`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var held, settled int64
		if err := rows.Scan(&id, &held, &settled); err != nil {
			rows.Close()
			return nil, err
		}
		entry := out[id]
		entry.held, entry.settled = held, settled
		out[id] = entry
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(ctx, `
		SELECT order_id::text, COALESCE(MAX(nudge_count), 0)::int, MAX(nudged_at_ms)
		  FROM delegate_dispatches
		 WHERE order_id = ANY($1::uuid[])
		 GROUP BY order_id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var nudges int32
		var nudged *int64
		if err := rows.Scan(&id, &nudges, &nudged); err != nil {
			return nil, err
		}
		entry := out[id]
		entry.nudges, entry.nudged = nudges, nudged
		out[id] = entry
	}
	return out, rows.Err()
}

// CreateLine is contract.CreateLine.
type CreateLine = contract.CreateLine

// CreateInput is contract.CreateInput.
type CreateInput = contract.CreateInput

// CreateOrder inserts or replays one posting.
func (r Repo) CreateOrder(ctx context.Context, orgID int64, in CreateInput) (contract.Order, error) {
	var orderID string
	err := r.writeTx(ctx, orgID, in.NowMS, func(tx pgx.Tx) error {
		var replayed bool
		var err error
		orderID, replayed, err = insertOrder(ctx, tx, orgID, in)
		if err != nil {
			return err
		}
		action := "delegate_order_created"
		if replayed {
			action = "delegate_order_replayed"
		}
		return audit(ctx, tx, orgID, in.UserID, "delegate_order", orderID, "POST", "/api/seller/delegate/orders", action, struct {
			PostingNumber  string `json:"postingNumber"`
			StoreID        string `json:"storeId"`
			IdempotencyKey string `json:"idempotencyKey"`
			Replayed       bool   `json:"replayed"`
		}{in.PostingNumber, in.StoreID, in.IdempotencyKey, replayed})
	})
	if err != nil {
		return contract.Order{}, err
	}
	return r.GetOrder(ctx, orgID, in.UserID, in.CanManage, orderID)
}

func insertOrder(ctx context.Context, tx pgx.Tx, orgID int64, in CreateInput) (string, bool, error) {
	var existing string
	err := tx.QueryRow(ctx, `
		SELECT order_id::text FROM delegate_orders
		 WHERE org_id = $1 AND store_id = $2::uuid AND posting_number = $3`, orgID, in.StoreID, in.PostingNumber).Scan(&existing)
	if err == nil {
		return existing, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, err
	}
	products := make([]domain.PostingProduct, len(in.Lines))
	for i, line := range in.Lines {
		products[i] = domain.PostingProduct{OfferID: line.OfferID, SKU: line.SKU, Name: line.Name, Quantity: line.Quantity}
	}
	wanted, err := domain.SelectLines(products, in.OfferIDs, in.OfferIDsSet)
	if err != nil {
		return "", false, err
	}
	logistics := ""
	if len(in.Logistics) > 0 {
		logistics = string(in.Logistics)
	}
	var orderID string
	err = tx.QueryRow(ctx, `
		INSERT INTO delegate_orders
		    (org_id, store_id, posting_number, seller_note, posting_snapshot, logistics, state, created_at_ms, updated_at_ms)
		VALUES ($1, $2::uuid, $3, $4, $5::jsonb, NULLIF($6, '')::jsonb, 'awaiting_setup', $7, $7)
		ON CONFLICT (org_id, store_id, posting_number) DO NOTHING
		RETURNING order_id::text`, orgID, in.StoreID, in.PostingNumber, in.SellerNote, string(in.Snapshot), logistics, in.NowMS).Scan(&orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			SELECT order_id::text FROM delegate_orders
			 WHERE org_id = $1 AND store_id = $2::uuid AND posting_number = $3`, orgID, in.StoreID, in.PostingNumber).Scan(&orderID)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, contract.Conflict("委托单已存在，回放失败")
		}
		return orderID, true, err
	}
	if err != nil {
		return "", false, err
	}
	bindings := map[string]string{}
	brows, err := tx.Query(ctx, `SELECT offer_id, binding_id::text FROM delegate_bindings WHERE org_id = $1 AND store_id = $2::uuid AND active`, orgID, in.StoreID)
	if err != nil {
		return "", false, err
	}
	for brows.Next() {
		var offer, binding string
		if err := brows.Scan(&offer, &binding); err != nil {
			brows.Close()
			return "", false, err
		}
		bindings[offer] = binding
	}
	brows.Close()
	if err := brows.Err(); err != nil {
		return "", false, err
	}
	for _, line := range wanted {
		var binding *string
		if id, ok := bindings[line.OfferID]; ok {
			binding = &id
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO delegate_order_lines
			    (org_id, order_id, offer_id, sku, name, quantity, binding_id)
			VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::uuid)
			ON CONFLICT (order_id, offer_id) DO NOTHING`,
			orgID, orderID, line.OfferID, line.SKU, line.Name, line.Quantity, binding); err != nil {
			return "", false, err
		}
	}
	if err := recompute(ctx, tx, orderID, in.NowMS); err != nil {
		return "", false, err
	}
	if in.Auto {
		if err := dispatchReady(ctx, tx, orgID, orderID, in.NowMS); err != nil {
			return "", false, err
		}
	}
	return orderID, false, nil
}

// CancelOrder recalls dispatched packets and optionally releases held settlements.
func (r Repo) CancelOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string, nowMS int64) (contract.Order, error) {
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		head, err := loadOrderActor(ctx, tx, orgID, userID, canManage, orderID)
		if err != nil {
			return err
		}
		var locked string
		err = tx.QueryRow(ctx, `SELECT order_id::text FROM delegate_orders WHERE order_id = $1::uuid FOR UPDATE`, orderID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("委托单不存在")
		}
		if err != nil {
			return err
		}
		head, err = loadOrderActor(ctx, tx, orgID, userID, canManage, orderID)
		if err != nil {
			return err
		}
		if head.State == "done" || head.State == "cancelled" {
			return contract.Conflict("委托单已是终态")
		}
		var accepted int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*)::bigint FROM delegate_dispatches
			 WHERE order_id = $1::uuid AND state IN ('accepted', 'shipped')`, orderID).Scan(&accepted); err != nil {
			return err
		}
		action := "delegate_order_cancelled"
		if accepted > 0 {
			action = "delegate_order_cancel_requested"
			if _, err := tx.Exec(ctx, `
				UPDATE delegate_orders SET cancel_requested = true, updated_at_ms = $4
				 WHERE order_id = $1::uuid AND org_id = $2 AND store_id = $3::uuid`,
				orderID, orgID, head.StoreID, nowMS); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `
			UPDATE delegate_orders SET state = 'cancelled', updated_at_ms = $4
			 WHERE order_id = $1::uuid AND org_id = $2 AND store_id = $3::uuid`,
			orderID, orgID, head.StoreID, nowMS); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE delegate_dispatches SET state = 'cancelled', updated_at_ms = $3
			 WHERE order_id = $1::uuid AND org_id = $2 AND state = 'dispatched'`, orderID, orgID, nowMS); err != nil {
			return err
		}
		if accepted == 0 {
			if err := releaseHeld(ctx, tx, orgID, orderID, nowMS); err != nil {
				return err
			}
		}
		return audit(ctx, tx, orgID, userID, "delegate_order", orderID, "POST", "/api/seller/delegate/orders/{order_id}/cancel", action, map[string]string{
			"postingNumber": head.PostingNumber,
		})
	})
	if err != nil {
		return contract.Order{}, err
	}
	return r.GetOrder(ctx, orgID, userID, canManage, orderID)
}

// CloseOrder moves dispatched, in_production, or shipped to done and releases held funds.
func (r Repo) CloseOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string, nowMS int64) (contract.Order, error) {
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		head, err := loadOrderActor(ctx, tx, orgID, userID, canManage, orderID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE delegate_orders SET state = 'done', updated_at_ms = $4
			 WHERE order_id = $1::uuid AND org_id = $2 AND store_id = $3::uuid
			   AND state IN ('dispatched', 'in_production', 'shipped')`, orderID, orgID, head.StoreID, nowMS)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return contract.Conflict("当前状态不能收口：未派发的单请先撤单")
		}
		if err := releaseHeld(ctx, tx, orgID, orderID, nowMS); err != nil {
			return err
		}
		return audit(ctx, tx, orgID, userID, "delegate_order", orderID, "POST", "/api/seller/delegate/orders/{order_id}/close", "delegate_order_closed", map[string]string{
			"postingNumber": head.PostingNumber,
		})
	})
	if err != nil {
		return contract.Order{}, err
	}
	return r.GetOrder(ctx, orgID, userID, canManage, orderID)
}

// NudgeOrder increments live packets outside the cooldown.
func (r Repo) NudgeOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string, nowMS int64) (contract.Order, error) {
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		head, err := loadOrderActor(ctx, tx, orgID, userID, canManage, orderID)
		if err != nil {
			return err
		}
		var state string
		err = tx.QueryRow(ctx, `SELECT state FROM delegate_orders WHERE order_id = $1::uuid AND org_id = $2`, orderID, orgID).Scan(&state)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("委托单不存在")
		}
		if err != nil {
			return err
		}
		if state != "dispatched" && state != "in_production" {
			return contract.Conflict("当前状态不能催单")
		}
		var live, recent int64
		if err := tx.QueryRow(ctx, `
			SELECT COUNT(*) FILTER (WHERE state IN ('dispatched', 'accepted'))::bigint,
			       COUNT(*) FILTER (WHERE state IN ('dispatched', 'accepted') AND nudged_at_ms IS NOT NULL AND nudged_at_ms > $3)::bigint
			  FROM delegate_dispatches
			 WHERE order_id = $1::uuid AND org_id = $2`, orderID, orgID, nowMS-domain.NudgeCooldownMS).Scan(&live, &recent); err != nil {
			return err
		}
		if live == 0 {
			return contract.Conflict("没有可催的派发包")
		}
		if recent > 0 {
			return contract.Conflict("半小时内已催过，请稍后再试")
		}
		if _, err := tx.Exec(ctx, `
			UPDATE delegate_dispatches
			   SET nudge_count = nudge_count + 1, nudged_at_ms = $3, updated_at_ms = $3
			 WHERE order_id = $1::uuid AND org_id = $2 AND state IN ('dispatched', 'accepted')`, orderID, orgID, nowMS); err != nil {
			return err
		}
		return audit(ctx, tx, orgID, userID, "delegate_order", orderID, "POST", "/api/seller/delegate/orders/{order_id}/nudge", "delegate_order_nudged", map[string]string{
			"postingNumber": head.PostingNumber,
		})
	})
	if err != nil {
		return contract.Order{}, err
	}
	return r.GetOrder(ctx, orgID, userID, canManage, orderID)
}

func releaseHeld(ctx context.Context, tx pgx.Tx, orgID int64, orderID string, nowMS int64) error {
	rows, err := tx.Query(ctx, `
		SELECT dispatch_id::text, amount_microfen
		  FROM delegate_settlements
		 WHERE order_id = $1::uuid AND org_id = $2 AND state = 'held'
		   FOR UPDATE`, orderID, orgID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type held struct {
		id     string
		amount int64
	}
	var list []held
	for rows.Next() {
		var row held
		if err := rows.Scan(&row.id, &row.amount); err != nil {
			return err
		}
		list = append(list, row)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, row := range list {
		if err := releaseSeller(ctx, tx, orgID, row.id, row.amount); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE delegate_settlements SET state = 'released', released_at_ms = $2
			 WHERE dispatch_id = $1::uuid AND state = 'held'`, row.id, nowMS)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return contract.Conflict("冻结退回没有落定")
		}
	}
	return nil
}

func releaseSeller(ctx context.Context, tx pgx.Tx, orgID int64, dispatchID string, amount int64) error {
	if amount <= 0 {
		return contract.Internal()
	}
	var owner int64
	if err := tx.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id = $1`, orgID).Scan(&owner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true)`, strconvFormat(owner)); err != nil {
		return err
	}
	key := "delegate:" + dispatchID
	note := "委托未发货，冻结退回"
	if err := walletRelease(ctx, tx, orgID, owner, key, amount, note); err != nil {
		return mapWallet(err)
	}
	return nil
}

func mapWallet(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case contains(msg, "refunded reservation"):
		return contract.Conflict("这笔冻结已退回，不能结算")
	case contains(msg, "settled reservation cannot be refunded"):
		return contract.Conflict("这笔成本已经划出，不能退回")
	default:
		var api *contract.APIError
		if errors.As(err, &api) {
			return err
		}
		return err
	}
}

func contains(s, part string) bool {
	return len(part) > 0 && len(s) >= len(part) && (s == part || len(s) > 0 && (indexOf(s, part) >= 0))
}

func indexOf(s, part string) int {
	for i := 0; i+len(part) <= len(s); i++ {
		if s[i:i+len(part)] == part {
			return i
		}
	}
	return -1
}

func walletRelease(ctx context.Context, tx pgx.Tx, orgID, owner int64, key string, amount int64, note string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, owner); err != nil {
		return err
	}
	var balance, held int64
	if err := tx.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM user_wallets WHERE user_id = $1 FOR UPDATE`, owner).Scan(&balance, &held); err != nil {
		return err
	}
	var settled int
	err := tx.QueryRow(ctx, `SELECT 1 FROM wallet_ledger WHERE org_id = $1 AND idempotency_key = $2 AND entry_type = 'settle' LIMIT 1`, orgID, key).Scan(&settled)
	if err == nil {
		return errors.New("a settled reservation cannot be refunded")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var priorHeld int64
	var priorAI *int64
	err = tx.QueryRow(ctx, `
		SELECT held_delta_microfen, ai_request_id FROM wallet_ledger
		 WHERE org_id = $1 AND idempotency_key = $2 AND entry_type = 'release' LIMIT 1`, orgID, key).Scan(&priorHeld, &priorAI)
	if err == nil {
		if priorHeld != -amount || priorAI != nil {
			return errors.New("refund parameters differ from the original reservation")
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var holdDelta int64
	var holdAI *int64
	err = tx.QueryRow(ctx, `
		SELECT held_delta_microfen, ai_request_id FROM wallet_ledger
		 WHERE org_id = $1 AND idempotency_key = $2 AND entry_type = 'hold' LIMIT 1`, orgID, key).Scan(&holdDelta, &holdAI)
	if errors.Is(err, pgx.ErrNoRows) || holdDelta != amount || holdAI != nil {
		return errors.New("the wallet reservation does not match this request")
	}
	if err != nil {
		return err
	}
	if held < amount {
		return errors.New("wallet is missing the reservation being refunded")
	}
	after := held - amount
	tag, err := tx.Exec(ctx, `
		UPDATE user_wallets
		   SET balance_microfen = $2, held_microfen = $3, version = version + 1, updated_at = clock_timestamp()
		 WHERE user_id = (SELECT owner_user_id FROM organizations WHERE id = $1)`, orgID, balance, after)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("wallet update affected rows")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO wallet_ledger
		    (org_id, user_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
		     balance_before_microfen, balance_after_microfen, held_before_microfen, held_after_microfen,
		     ai_request_id, payment_order_id, note)
		VALUES ($1, (SELECT owner_user_id FROM organizations WHERE id = $1),
		        'release', $2, 0, $3, $4, $4, $5, $6, NULL, NULL, $7)`,
		orgID, key, -amount, balance, held, after, note)
	return err
}

func strconvFormat(n int64) string {
	return jsonNumber(n)
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// LoadMerge reads ready offers and open orders for one store.
func (r Repo) LoadMerge(ctx context.Context, orgID int64, storeID string) (contract.MergeSnapshot, error) {
	var out contract.MergeSnapshot
	ready := map[string]struct{}{}
	orders := map[string]*contract.OpenPosting{}
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT b.offer_id
			  FROM delegate_bindings b
			 WHERE b.org_id = $1 AND b.store_id = $2::uuid AND b.active IS TRUE
			   AND EXISTS (
			         SELECT 1 FROM delegate_assets a
			          WHERE a.binding_id = b.binding_id AND a.verified_at_ms IS NOT NULL)`, orgID, storeID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var offer string
			if err := rows.Scan(&offer); err != nil {
				rows.Close()
				return err
			}
			ready[offer] = struct{}{}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		rows, err = tx.Query(ctx, `
			SELECT o.posting_number, o.order_id::text, o.state, l.offer_id
			  FROM delegate_orders o
			  JOIN delegate_order_lines l ON l.order_id = o.order_id
			 WHERE o.org_id = $1 AND o.store_id = $2::uuid
			   AND o.state IN (`+openStates+`)`, orgID, storeID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var posting, orderID, state, offer string
			if err := rows.Scan(&posting, &orderID, &state, &offer); err != nil {
				return err
			}
			entry := orders[posting]
			if entry == nil {
				entry = &contract.OpenPosting{PostingNumber: posting, OrderID: orderID, State: state}
				orders[posting] = entry
			}
			entry.Offers = append(entry.Offers, offer)
		}
		return rows.Err()
	})
	for offer := range ready {
		out.Ready = append(out.Ready, offer)
	}
	sort.Strings(out.Ready)
	for _, entry := range orders {
		out.Orders = append(out.Orders, *entry)
	}
	sort.Slice(out.Orders, func(i, j int) bool { return out.Orders[i].PostingNumber < out.Orders[j].PostingNumber })
	if out.Ready == nil {
		out.Ready = []string{}
	}
	if out.Orders == nil {
		out.Orders = []contract.OpenPosting{}
	}
	return out, err
}

// PostingStates reads open orders for the requested posting numbers.
func (r Repo) PostingStates(ctx context.Context, orgID int64, storeID string, numbers []string) ([]contract.PostingHit, error) {
	var out []contract.PostingHit
	if len(numbers) == 0 {
		return out, nil
	}
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT o.posting_number, o.order_id::text, o.state, l.offer_id
			  FROM delegate_orders o
			  LEFT JOIN delegate_order_lines l ON l.order_id = o.order_id
			 WHERE o.org_id = $1 AND o.store_id = $2::uuid
			   AND o.posting_number = ANY($3)
			   AND o.state NOT IN ('done', 'cancelled')`, orgID, storeID, numbers)
		if err != nil {
			return err
		}
		defer rows.Close()
		index := map[string]int{}
		for rows.Next() {
			var posting, orderID, state string
			var offer *string
			if err := rows.Scan(&posting, &orderID, &state, &offer); err != nil {
				return err
			}
			at, ok := index[posting]
			if !ok {
				index[posting] = len(out)
				out = append(out, contract.PostingHit{PostingNumber: posting, OrderID: orderID, State: state})
				at = index[posting]
			}
			if offer != nil && *offer != "" {
				out[at].Offers = append(out[at].Offers, *offer)
			}
		}
		return rows.Err()
	})
	return out, err
}

// StorageRevision is the integration singleton revision, or 0 when the row is absent.
func (r Repo) StorageRevision(ctx context.Context, orgID int64) (int64, bool, error) {
	var revision int64
	var ok bool
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT revision, octet_length(ciphertext) > 0 FROM platform_integration_config WHERE singleton = true`).Scan(&revision, &ok)
		if errors.Is(err, pgx.ErrNoRows) {
			revision, ok = 0, false
			return nil
		}
		return err
	})
	return revision, ok, err
}
