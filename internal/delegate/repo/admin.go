package delegaterepo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// Dispatch writes packets, clears the latch, and recomputes the order.
func (r Repo) Dispatch(ctx context.Context, cmd domain.AdminCommand, in domain.DispatchInput) (json.RawMessage, error) {
	orgID, posting, err := r.resolveOrder(ctx, cmd.OrderID)
	if err != nil {
		return nil, err
	}
	err = r.writeOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := lockOrder(ctx, tx, cmd.OrderID); err != nil {
			return err
		}
		state, logistics, note, err := loadOrder(ctx, tx, orgID, cmd.OrderID)
		if err != nil {
			return err
		}
		if state == "done" || state == "cancelled" {
			return contract.Conflict("委托单已是终态")
		}
		if len(logistics) == 0 || string(logistics) == "null" {
			return contract.Conflict("物流快照缺失，派发被阻塞；等同步补齐后再试")
		}
		if in.SourceID != "" {
			var one int
			err := tx.QueryRow(ctx, `SELECT 1 FROM sc_sources WHERE source_id = $1 LIMIT 1`, in.SourceID).Scan(&one)
			if errors.Is(err, pgx.ErrNoRows) {
				return contract.NotFound("厂家不存在")
			}
			if err != nil {
				return mapDB(err)
			}
		}
		lines, err := dispatchableLines(ctx, tx, cmd.OrderID, in.SourceID)
		if err != nil {
			return err
		}
		ids := make([]string, len(lines))
		for i, line := range lines {
			ids[i] = line.LineID
		}
		selected, err := domain.ResolveRequestedLines(ids, in.LineIDs)
		if err != nil {
			return err
		}
		if len(selected) == 0 {
			if in.SourceID != "" {
				return contract.Unprocessable("该厂家名下没有可派发的行（未绑定、缺已核验原图或已在途）")
			}
			return contract.Unprocessable("这张单没有可派发的行（未绑定、缺已核验原图或已在途）")
		}
		want := map[string]bool{}
		for _, id := range selected {
			want[id] = true
		}
		var kept []dispatchLine
		for _, line := range lines {
			if want[line.LineID] {
				kept = append(kept, line)
			}
		}
		written, err := writePackets(ctx, tx, orgID, cmd.OrderID, posting, note, logistics, kept, "admin:"+itoa(cmd.UserID), cmd.NowMS, cmd.NewID)
		if err != nil {
			return err
		}
		if len(written) == 0 {
			return contract.Conflict("这些行所在厂家已有在途派发包，没有新的包")
		}
		var lineIDs []string
		for _, id := range written {
			lineIDs = append(lineIDs, id.lines...)
		}
		if len(lineIDs) > 0 {
			if _, err := tx.Exec(ctx, `UPDATE delegate_order_lines SET last_rejected_source_id = NULL WHERE line_id = ANY($1::uuid[])`, lineIDs); err != nil {
				return mapDB(err)
			}
		}
		if err := recompute(ctx, tx, cmd.OrderID, cmd.NowMS); err != nil {
			return err
		}
		return audit(ctx, tx, orgID, cmd.UserID, "delegate_order", cmd.OrderID, "POST", "/api/admin/delegate-orders/{order_id}/dispatch", "delegate_order_manually_dispatched", map[string]string{"postingNumber": posting})
	})
	if err != nil {
		return nil, err
	}
	return r.loadDetail(ctx, cmd.OrderID)
}

// Receipt ships the latest live packet and settles it before commit.
func (r Repo) Receipt(ctx context.Context, cmd domain.AdminCommand, in domain.ReceiptInput) (json.RawMessage, error) {
	orgID, posting, err := r.resolveOrder(ctx, cmd.OrderID)
	if err != nil {
		return nil, err
	}
	var dispatchID, storeID string
	err = r.writeOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := lockOrder(ctx, tx, cmd.OrderID); err != nil {
			return err
		}
		state, _, _, err := loadOrder(ctx, tx, orgID, cmd.OrderID)
		if err != nil {
			return err
		}
		if state == "done" || state == "cancelled" {
			return contract.Conflict("委托单已是终态")
		}
		err = tx.QueryRow(ctx, `
			SELECT dispatch_id::text FROM delegate_dispatches
			WHERE order_id = $1::uuid AND state IN ('dispatched', 'accepted')
			ORDER BY created_at_ms DESC, dispatch_id DESC
			LIMIT 1 FOR UPDATE`, cmd.OrderID).Scan(&dispatchID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Conflict("没有可代录回执的派发包：最新包不在待接单/生产中")
		}
		if err != nil {
			return mapDB(err)
		}
		tag, err := tx.Exec(ctx, `
			UPDATE delegate_dispatches
			SET state = 'shipped',
			    receipt = jsonb_build_object('tracking_no', $3::text, 'note', $4::text, 'recorded_by', $5::text, 'at_ms', $6::bigint),
			    updated_at_ms = $6
			WHERE dispatch_id = $2::uuid AND state IN ('dispatched', 'accepted')`,
			cmd.OrderID, dispatchID, in.TrackingNo, in.Note, "admin:"+itoa(cmd.UserID), cmd.NowMS)
		if err != nil {
			return mapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return contract.Conflict("没有可代录回执的派发包：最新包不在待接单/生产中")
		}
		if err := recompute(ctx, tx, cmd.OrderID, cmd.NowMS); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
			return mapDB(err)
		}
		if err := settleDispatch(ctx, tx, dispatchID, cmd.NowMS); err != nil {
			return err
		}
		if err := audit(ctx, tx, orgID, cmd.UserID, "delegate_dispatch", dispatchID, "POST", "/api/admin/delegate-orders/{order_id}/receipt", "delegate_receipt_recorded_by_admin", map[string]string{"postingNumber": posting}); err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT store_id::text FROM delegate_orders WHERE order_id = $1::uuid`, cmd.OrderID).Scan(&storeID)
		if err != nil {
			return mapDB(err)
		}
		tracking := ""
		if in.TrackingNo != "" {
			tracking = in.TrackingNo
		}
		return notify(ctx, tx, orgID, storeID, cmd.OrderID, dispatchID, posting, "shipped", tracking, "")
	})
	if err != nil {
		return nil, err
	}
	return r.loadDetail(ctx, cmd.OrderID)
}

// Cancel recalls unaccepted packets. Accepted work only raises the flag.
func (r Repo) Cancel(ctx context.Context, cmd domain.AdminCommand) (json.RawMessage, error) {
	orgID, posting, err := r.resolveOrder(ctx, cmd.OrderID)
	if err != nil {
		return nil, err
	}
	err = r.writeOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := lockOrder(ctx, tx, cmd.OrderID); err != nil {
			return err
		}
		state, _, _, err := loadOrder(ctx, tx, orgID, cmd.OrderID)
		if err != nil {
			return err
		}
		var accepted int64
		if err := tx.QueryRow(ctx, `SELECT count(*)::bigint FROM delegate_dispatches WHERE order_id = $1::uuid AND state IN ('accepted', 'shipped')`, cmd.OrderID).Scan(&accepted); err != nil {
			return mapDB(err)
		}
		edge, err := domain.AdminCancel(state, int(accepted))
		if err != nil {
			return err
		}
		if edge.CancelRequested {
			if _, err := tx.Exec(ctx, `UPDATE delegate_orders SET cancel_requested = true, updated_at_ms = $3 WHERE order_id = $1::uuid AND org_id = $2`, cmd.OrderID, orgID, cmd.NowMS); err != nil {
				return mapDB(err)
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE delegate_orders SET state = 'cancelled', updated_at_ms = $3 WHERE order_id = $1::uuid AND org_id = $2`, cmd.OrderID, orgID, cmd.NowMS); err != nil {
				return mapDB(err)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE delegate_dispatches SET state = 'cancelled', updated_at_ms = $3 WHERE order_id = $1::uuid AND org_id = $2 AND state = 'dispatched'`, cmd.OrderID, orgID, cmd.NowMS); err != nil {
			return mapDB(err)
		}
		action := "delegate_order_cancelled_by_admin"
		if edge.CancelRequested {
			action = "delegate_order_cancel_requested_by_admin"
		}
		if err := audit(ctx, tx, orgID, cmd.UserID, "delegate_order", cmd.OrderID, "POST", "/api/admin/delegate-orders/{order_id}/cancel", action, map[string]string{"postingNumber": posting}); err != nil {
			return err
		}
		if edge.ReleaseHeld {
			if err := releaseHeld(ctx, tx, orgID, cmd.OrderID, cmd.NowMS); err != nil {
				return err
			}
		}
		if !edge.CancelRequested {
			var storeID string
			if err := tx.QueryRow(ctx, `SELECT store_id::text FROM delegate_orders WHERE order_id = $1::uuid`, cmd.OrderID).Scan(&storeID); err != nil {
				return mapDB(err)
			}
			return notify(ctx, tx, orgID, storeID, cmd.OrderID, "", posting, "cancelled", "", "")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return r.loadDetail(ctx, cmd.OrderID)
}

func (r Repo) resolveOrder(ctx context.Context, orderID string) (int64, string, error) {
	if r.pool == nil {
		return 0, "", contract.Internal()
	}
	var orgID int64
	var posting string
	var fnErr error
	err := db.InTx(ctx, r.pool, db.Staff(), func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT org_id, posting_number FROM delegate_orders WHERE order_id = $1::uuid`, orderID).Scan(&orgID, &posting)
		if errors.Is(err, pgx.ErrNoRows) {
			fnErr = contract.NotFound("委托单不存在")
		} else if err != nil {
			fnErr = mapDB(err)
		}
		return fnErr
	})
	if err == nil {
		return orgID, posting, nil
	}
	if fnErr != nil {
		return 0, "", err
	}
	return 0, "", mapDB(err)
}

func (r Repo) writeOrg(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r.pool == nil || r.begin == nil {
		return contract.Internal()
	}
	var fnErr error
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		fnErr = lockedOrgWrite(ctx, tx, orgID, fn)
		return fnErr
	})
	if err == nil || fnErr != nil {
		return err
	}
	return mapDB(err)
}

func lockedOrgWrite(ctx context.Context, tx pgx.Tx, orgID int64, fn func(pgx.Tx) error) error {
	if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
		return mapDB(err)
	}
	if err := assertAdminWrite(ctx, tx); err != nil {
		return err
	}
	var locked int64
	err := tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id = $1 AND dissolved_at IS NULL FOR UPDATE`, orgID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.Internal()
	}
	if err != nil {
		return mapDB(err)
	}
	return fn(tx)
}

func assertAdminWrite(ctx context.Context, tx pgx.Tx) error {
	_, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), time.Now().UnixMilli(), "委托订单写入未启用")
	if err == nil {
		return nil
	}
	if writer.IsDisabled(err) {
		return contract.WritesDisabled()
	}
	return mapDB(err)
}

func lockOrder(ctx context.Context, tx pgx.Tx, orderID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT order_id::text FROM delegate_orders WHERE order_id = $1::uuid FOR UPDATE`, orderID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.NotFound("委托单不存在")
	}
	return mapDB(err)
}

func loadOrder(ctx context.Context, tx pgx.Tx, orgID int64, orderID string) (state string, logistics []byte, note string, err error) {
	err = tx.QueryRow(ctx, `SELECT state, logistics, seller_note FROM delegate_orders WHERE order_id = $1::uuid AND org_id = $2`, orderID, orgID).Scan(&state, &logistics, &note)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, "", contract.NotFound("委托单不存在")
	}
	if err != nil {
		return "", nil, "", mapDB(err)
	}
	return state, logistics, note, nil
}

type dispatchLine struct {
	LineID  string
	OfferID string
	Name    string
	Qty     int32
	Source  string
	Assets  []byte
}

func dispatchableLines(ctx context.Context, tx pgx.Tx, orderID, sourceID string) ([]dispatchLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.line_id::text, l.offer_id, l.name, l.quantity, s.source_id,
		       COALESCE((SELECT jsonb_agg(jsonb_build_object(
		                   'asset_id', a.asset_id::text,
		                   'file_name', a.file_name,
		                   'object_key', a.object_key,
		                   'sha256', a.sha256,
		                   'bytes', a.bytes,
		                   'mime', a.mime) ORDER BY a.position, a.created_at_ms)
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
		  AND ($2 = '' OR s.source_id = $2)
		ORDER BY l.line_id`, orderID, sourceID)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	var out []dispatchLine
	for rows.Next() {
		var line dispatchLine
		if err := rows.Scan(&line.LineID, &line.OfferID, &line.Name, &line.Qty, &line.Source, &line.Assets); err != nil {
			return nil, mapDB(err)
		}
		out = append(out, line)
	}
	return out, mapDB(rows.Err())
}

type writtenPacket struct{ lines []string }

func writePackets(ctx context.Context, tx pgx.Tx, orgID int64, orderID, posting, note string, logistics []byte, lines []dispatchLine, attempted string, now int64, newID func() string) ([]writtenPacket, error) {
	bySource := map[string][]dispatchLine{}
	var order []string
	for _, line := range lines {
		if _, ok := bySource[line.Source]; !ok {
			order = append(order, line.Source)
		}
		bySource[line.Source] = append(bySource[line.Source], line)
	}
	// Packets are inserted in source id order, not first-seen order.
	sortStrings(order)
	var written []writtenPacket
	for _, source := range order {
		group := bySource[source]
		type wireLine struct {
			LineID  string          `json:"line_id"`
			OfferID string          `json:"offer_id"`
			Name    string          `json:"name"`
			Qty     int32           `json:"quantity"`
			Assets  json.RawMessage `json:"assets"`
		}
		var wl []wireLine
		var ids []string
		for _, line := range group {
			assets := json.RawMessage(line.Assets)
			if len(assets) == 0 {
				assets = []byte("[]")
			}
			wl = append(wl, wireLine{LineID: line.LineID, OfferID: line.OfferID, Name: line.Name, Qty: line.Qty, Assets: assets})
			ids = append(ids, line.LineID)
		}
		payload, err := json.Marshal(struct {
			Posting   string          `json:"posting_number"`
			Note      string          `json:"seller_note"`
			Logistics json.RawMessage `json:"logistics"`
			Lines     []wireLine      `json:"lines"`
		}{posting, note, logistics, wl})
		if err != nil {
			return nil, contract.Internal()
		}
		no := "dsp_" + strings.ReplaceAll(newID(), "-", "")
		var id *string
		err = tx.QueryRow(ctx, `
			INSERT INTO delegate_dispatches
			    (org_id, order_id, source_id, dispatch_no, payload, state, attempted_by, created_at_ms, updated_at_ms)
			VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 'dispatched', $6, $7, $7)
			ON CONFLICT (order_id, source_id) WHERE state = 'dispatched' DO NOTHING
			RETURNING dispatch_id::text`, orgID, orderID, source, no, payload, attempted, now).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, mapDB(err)
		}
		written = append(written, writtenPacket{lines: ids})
	}
	return written, nil
}

func notify(ctx context.Context, tx pgx.Tx, orgID int64, storeID, orderID, dispatchID, posting, event, tracking, reason string) error {
	source := ""
	if dispatchID != "" {
		_ = tx.QueryRow(ctx, `
			SELECT COALESCE(s.name, '') FROM delegate_dispatches d
			LEFT JOIN sc_sources s ON s.source_id = d.source_id
			WHERE d.dispatch_id = $1::uuid`, dispatchID).Scan(&source)
	}
	var userID *int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(
		    (SELECT m.user_id FROM organization_stores s
		      JOIN organization_members m ON m.id = s.assignee_membership_id
		      WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.assignee_membership_id IS NOT NULL),
		    (SELECT owner_user_id FROM organizations WHERE id = $1))`, orgID, storeID).Scan(&userID)
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
	}{event, orderID, posting, source, nullStr(tracking), nullStr(reason)})
	_, err = tx.Exec(ctx, `
		INSERT INTO notifications (uuid, user_id, kind, payload, created_at)
		VALUES (gen_random_uuid(), $1, 'delegate_order_event', $2::jsonb, clock_timestamp())`, *userID, payload)
	return mapDB(err)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func sortStrings(a []string) {
	for i := 1; i < len(a); i++ {
		j := i
		for j > 0 && a[j] < a[j-1] {
			a[j], a[j-1] = a[j-1], a[j]
			j--
		}
	}
}
