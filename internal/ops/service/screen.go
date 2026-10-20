// Package service is the ops use-case layer. It does not import net/http or the repo.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	"github.com/xxww0098/podhub-go/internal/ops/domain"
)

// Actor is the workspace session the HTTP layer already resolved.
type Actor struct {
	UserID int64
	OrgID  int64
	Role   string
}

// Screen is every ops route. Nil dependencies fail closed as internal.
type Screen struct {
	Stores         contract.Stores
	Ledger         contract.Ledger
	Console        contract.ConsoleRead
	Refresh        contract.Refresher
	Seller         contract.Seller
	Now            func() time.Time
	HeartbeatEvery time.Duration
}

func (s *Screen) now() time.Time {
	if s == nil || s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

func (s *Screen) fetch(ctx context.Context, lane contract.Lane, secret contract.Secret) domain.Fetch {
	return func(method, path string, body []byte) domain.Page {
		if s == nil || s.Seller == nil {
			return domain.Page{Err: contract.ErrUnreachable}
		}
		status, resp, err := s.Seller.Call(ctx, lane, method, path, body, secret)
		return domain.Page{Status: status, Body: resp, Err: err}
	}
}

func (s *Screen) admit(ctx context.Context, a Actor, storeID string) (contract.Admitted, *contract.Fail) {
	id, ok := domain.NormalizeUUID(storeID)
	if !ok {
		return contract.Admitted{}, &contract.Fail{Status: 404, Code: contract.CodeNotFound, Message: contract.MsgStoreMissing}
	}
	if s.Stores == nil {
		return contract.Admitted{}, contract.Internal("")
	}
	got, err := s.Stores.Admit(ctx, a.OrgID, a.UserID, a.Role, id, s.now().UnixMilli())
	if err != nil {
		var f *contract.Fail
		if errors.As(err, &f) {
			return contract.Admitted{}, f
		}
		return contract.Admitted{}, contract.Internal("")
	}
	return got, nil
}

func decodeFail(err error) *contract.Fail {
	if err != nil {
		return contract.NotPorted()
	}
	return nil
}

func (s *Screen) Shipping(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeShipping(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return domain.Shipping(s.now(), req, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) Returns(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeReturns(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	if f := domain.ValidateReturns(req); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return domain.Returns(req, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) Cancellations(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeCancel(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	if f := domain.ValidateCancel(req); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return domain.Cancellations(req, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) Reviews(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	return s.withCursor(ctx, a, raw, "last_id", domain.Reviews)
}

func (s *Screen) Questions(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	return s.withCursor(ctx, a, raw, "last_id", domain.Questions)
}

func (s *Screen) Chats(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	return s.withCursor(ctx, a, raw, "cursor", domain.Chats)
}

func (s *Screen) withCursor(ctx context.Context, a Actor, raw []byte, key string, run func(domain.CursorRequest, domain.Fetch) (json.RawMessage, *contract.Fail)) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeCursor(raw, key)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return run(req, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) SupplyOrders(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeSupplyList(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	states, f := domain.ListFilterStates(req.States)
	if f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return domain.SupplyOrders(req, states, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) SupplyStocks(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	store, err := domain.DecodeSupplyStocks(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, store)
	if f != nil {
		return nil, f
	}
	return domain.SupplyWarehouseStocks(s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) History(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	m, err := objectStoreChat(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	if strings.TrimSpace(m[1]) == "" {
		return nil, contract.Validation("会话身份无效")
	}
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, m[0])
	if f != nil {
		return nil, f
	}
	return domain.History(admitted.UUID, m[1], s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func objectStoreChat(raw []byte) ([2]string, error) {
	type body struct {
		StoreID string `json:"store_id"`
		ChatID  string `json:"chat_id"`
	}
	// deny unknown via domain decoder used by history: store_id + chat_id only.
	req, err := domain.DecodeCursor(raw, "chat_id")
	if err != nil {
		return [2]string{}, err
	}
	return [2]string{req.StoreID, req.Cursor}, nil
}

func (s *Screen) Inbox(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	stores, err := domain.DecodeInbox(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	views := make([]domain.StoreInbox, 0, len(stores))
	for _, ref := range stores {
		admitMsg := ""
		var secret contract.Secret
		if strings.TrimSpace(ref.StoreID) != "" {
			admitted, f := s.admit(ctx, a, ref.StoreID)
			if f != nil {
				admitMsg = f.Message
			} else {
				secret = admitted.Secret
			}
		}
		fetch := s.fetch(ctx, contract.LaneRead, secret)
		views = append(views, domain.FetchInbox(ref, admitMsg, fetch))
	}
	return domain.AggregateInbox(views), nil
}

func (s *Screen) Sync(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	return s.monitor(ctx, a, raw, false)
}

func (s *Screen) Metrics(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeMetrics(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	if f := domain.ValidateSKU(req.SKU); f != nil {
		return nil, f
	}
	if f := domain.ValidateDays(req.Days); f != nil {
		return nil, f
	}
	return domain.SyncMetrics(s.now(), req, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret), 0)
}

func (s *Screen) monitor(ctx context.Context, a Actor, raw []byte, _ bool) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeMonitor(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	if f := domain.ValidateSKU(req.SKU); f != nil {
		return nil, f
	}
	if f := domain.ValidateDays(req.MetricsDays); f != nil {
		return nil, f
	}
	offers, f := domain.ValidateOffers(req.OfferIDs, req.SKU)
	if f != nil {
		return nil, f
	}
	return domain.SyncProducts(s.now(), req, offers, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret), 0)
}

func (s *Screen) Warehouses(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	req, err := domain.DecodeWarehouses(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return domain.Warehouses(req, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) Promotions(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	req, err := domain.DecodePromotions(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	ids := domain.PositiveProducts(req.ProductIDs)
	if len(ids) == 0 {
		return domain.EmptyPromotions(), nil
	}
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, req.StoreID)
	if f != nil {
		return nil, f
	}
	return domain.Promotions(ids, s.fetch(ctx, contract.LaneInteractiveRead, admitted.Secret))
}

func (s *Screen) Mutate(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	cmd, err := domain.DecodeMutation(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	if f := domain.ValidateMutation(cmd); f != nil {
		return nil, f
	}
	if f := domain.RequireSubmit(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, cmd.StoreID)
	if f != nil {
		return nil, f
	}
	if s.Seller != nil && s.Seller.WritesDisabled() {
		return nil, contract.WritesOff()
	}
	key := domain.ProductKey(admitted.UUID, strings.ToLower(strings.TrimSpace(cmd.OperationID)))
	hash := domain.RequestHash(admitted.UUID, cmd.Stored)
	row, f := s.begin(ctx, a.OrgID, admitted.StorePK, key, hash, contract.KindProductMutation, cmd.Stored)
	if f != nil {
		return nil, f
	}
	if !row.Inserted {
		return s.replay(row, true)
	}
	stop := s.beat(ctx, a.OrgID, admitted.StorePK, key)
	defer stop()
	view, fail, unknown := domain.Dispatch(cmd, s.fetch(ctx, contract.LaneInteractiveWrite, admitted.Secret))
	return s.finish(ctx, a.OrgID, admitted.StorePK, key, hash, view, fail, unknown, contract.ResultUnknownProduct, contract.CodeProducts)
}

func (s *Screen) Send(ctx context.Context, a Actor, raw []byte) (json.RawMessage, *contract.Fail) {
	store, chat, text, err := domain.DecodeSend(raw)
	if f := decodeFail(err); f != nil {
		return nil, f
	}
	if f := domain.ValidateSend(chat, text); f != nil {
		return nil, f
	}
	if f := domain.RequireSubmit(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	admitted, f := s.admit(ctx, a, store)
	if f != nil {
		return nil, f
	}
	if s.Seller != nil && s.Seller.WritesDisabled() {
		return nil, contract.WritesOff()
	}
	chat = strings.TrimSpace(chat)
	text = strings.TrimSpace(text)
	stored, err := json.Marshal(domain.ChatSendRequest{ChatID: chat, Text: text})
	if err != nil {
		return nil, contract.Validation(err.Error())
	}
	key := domain.ChatKey(admitted.UUID, chat, text)
	hash := domain.RequestHash(admitted.UUID, stored)
	row, f := s.begin(ctx, a.OrgID, admitted.StorePK, key, hash, contract.KindChatSend, stored)
	if f != nil {
		return nil, f
	}
	if !row.Inserted {
		return s.replay(row, false)
	}
	stop := s.beat(ctx, a.OrgID, admitted.StorePK, key)
	defer stop()
	result, fail, unknown := domain.SendMessage(chat, text, s.fetch(ctx, contract.LaneInteractiveWrite, admitted.Secret))
	view, _ := json.Marshal(struct {
		StoreID string `json:"store_id"`
		ChatID  string `json:"chat_id"`
		Result  string `json:"result"`
	}{StoreID: admitted.UUID, ChatID: chat, Result: result})
	return s.finish(ctx, a.OrgID, admitted.StorePK, key, hash, view, fail, unknown, contract.ResultUnknownChat, contract.CodeMessage)
}

func (s *Screen) begin(ctx context.Context, org, store int64, key, hash, kind string, body []byte) (contract.LedgerRow, *contract.Fail) {
	if s.Ledger == nil {
		return contract.LedgerRow{}, contract.Internal("")
	}
	row, err := s.Ledger.Begin(ctx, org, store, key, hash, kind, body)
	if err != nil {
		var f *contract.Fail
		if errors.As(err, &f) {
			return contract.LedgerRow{}, f
		}
		return contract.LedgerRow{}, contract.Internal("")
	}
	if !row.Inserted && row.State != "settled" {
		return contract.LedgerRow{}, &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: contract.MsgInFlight}
	}
	return row, nil
}

func (s *Screen) replay(row contract.LedgerRow, product bool) (json.RawMessage, *contract.Fail) {
	if row.Status == 200 {
		if !json.Valid(row.Body) {
			return nil, &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "该操作已结算但回执不可读，请先同步商品确认状态"}
		}
		return envelope(row.Body), nil
	}
	var parsed struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	code := contract.CodeProducts
	msg := "该操作此前已被 Ozon 拒绝"
	if json.Unmarshal(row.Body, &parsed) == nil && parsed.Code != "" {
		code = parsed.Code
		msg = parsed.Error
	}
	_ = product
	status := row.Status
	if status == 0 {
		status = 502
	}
	return nil, &contract.Fail{Status: status, Code: code, Message: msg}
}

func (s *Screen) finish(ctx context.Context, org, store int64, key, hash string, view json.RawMessage, fail *contract.Fail, unknown bool, unknownCode, ledgerCode string) (json.RawMessage, *contract.Fail) {
	if unknown {
		msg := ""
		if fail != nil {
			msg = fail.Message
		}
		if err := s.Ledger.MarkUnknown(ctx, org, store, key, hash, unknownCode, msg, 60); err != nil {
			return nil, contract.Internal("")
		}
		return nil, fail
	}
	if fail != nil {
		body := domain.OpsError(fail.Message, ledgerCode)
		if err := s.Ledger.Settle(ctx, org, store, key, hash, fail.Status, body); err != nil {
			return nil, contract.Internal("")
		}
		return nil, fail
	}
	if err := s.Ledger.Settle(ctx, org, store, key, hash, 200, view); err != nil {
		return nil, contract.Internal("")
	}
	return envelope(view), nil
}

func envelope(inner json.RawMessage) json.RawMessage {
	if len(inner) == 0 {
		inner = []byte(`null`)
	}
	return append(append([]byte(`{"data":`), inner...), '}')
}

func (s *Screen) beat(ctx context.Context, org, store int64, key string) func() {
	if s.HeartbeatEvery <= 0 || s.Ledger == nil {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		tick := time.NewTicker(s.HeartbeatEvery)
		defer tick.Stop()
		life := time.NewTimer(15 * time.Minute)
		defer life.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-life.C:
				return
			case <-tick.C:
				_ = s.Ledger.Heartbeat(ctx, org, store, key)
			}
		}
	}()
	return func() { close(done) }
}

func (s *Screen) Snapshot(ctx context.Context, a Actor) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	if s.Console == nil {
		return nil, contract.Internal("")
	}
	heads, meta, err := s.Console.Roster(ctx, a.OrgID, a.UserID, a.Role)
	if err != nil {
		var f *contract.Fail
		if errors.As(err, &f) {
			f.Code = contract.CodeInternal
			return nil, f
		}
		return nil, contract.Internal("")
	}
	ids := make([]string, 0, len(heads))
	for _, h := range heads {
		ids = append(ids, h.UUID)
	}
	ledger, err := s.Console.Ledger(ctx, a.OrgID, domain.LedgerRowCap)
	if err != nil {
		return nil, contract.Internal("")
	}
	metrics, err := s.Console.Metrics(ctx, a.OrgID, ids)
	if err != nil {
		return nil, contract.Internal("")
	}
	products, err := s.Console.Products(ctx, a.OrgID, ids)
	if err != nil {
		return nil, contract.Internal("")
	}
	return envelope(domain.SnapshotJSON(meta, heads, ledger, metrics, products)), nil
}

func (s *Screen) RefreshMetrics(ctx context.Context, a Actor) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireStoreRead(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	if s.Console == nil || s.Refresh == nil {
		return nil, contract.Internal("")
	}
	heads, _, err := s.Console.Roster(ctx, a.OrgID, a.UserID, a.Role)
	if err != nil {
		return nil, contract.Internal("")
	}
	var ids []string
	for _, h := range heads {
		if domain.Refreshable(h.Configured, cloudStatus(h)) {
			ids = append(ids, h.UUID)
		}
	}
	nowMS := s.now().UnixMilli()
	if nowMS < 1 {
		nowMS = 1
	}
	results, metrics, err := s.Refresh.Refresh(ctx, a.OrgID, ids, nowMS, func(storeID string) (float64, []float64, string, int64, string, *int64, error) {
		admitted, f := s.admit(ctx, a, storeID)
		if f != nil {
			return 0, nil, "", 0, f.Message, nil, errors.New(f.Message)
		}
		ordered, days, through, fail := domain.ConsoleOrdered(s.now(), s.fetch(ctx, contract.LaneRead, admitted.Secret))
		if fail != "" {
			var retry *int64
			if strings.Contains(fail, "429") || strings.Contains(fail, "频繁") {
				at := nowMS + 60_000
				retry = &at
			}
			return 0, nil, "", 0, fail, retry, errors.New(fail)
		}
		snap := domain.ConsoleSnapshot{Ordered: ordered, Days: days, Through: through, SyncMS: nowMS}
		if !domain.Validated(snap) {
			return 0, nil, "", 0, "30 日出单快照不完整", nil, errors.New("30 日出单快照不完整")
		}
		return ordered, days, through, nowMS, "", nil, nil
	})
	if err != nil {
		var f *contract.Fail
		if errors.As(err, &f) {
			return nil, f
		}
		return nil, contract.Internal("")
	}
	raw, err := json.Marshal(struct {
		Results []contract.RefreshResult `json:"results"`
		Metrics []contract.MetricRow     `json:"metrics"`
	}{Results: results, Metrics: metrics})
	if err != nil {
		return nil, contract.Internal("")
	}
	return envelope(raw), nil
}

func cloudStatus(h contract.StoreHead) string {
	switch {
	case h.QuotaSuspended:
		return "quota_suspended"
	case h.ManualDisabled:
		return "manual_disabled"
	default:
		return "active"
	}
}

func (s *Screen) Reconcile(ctx context.Context, a Actor) (json.RawMessage, *contract.Fail) {
	if f := domain.RequireReconcile(a.OrgID, a.Role); f != nil {
		return nil, f
	}
	if s.Console == nil {
		return nil, contract.Internal("")
	}
	heads, _, err := s.Console.Roster(ctx, a.OrgID, a.UserID, a.Role)
	if err != nil {
		return nil, contract.Internal("")
	}
	ids := make([]string, 0, len(heads))
	for _, h := range heads {
		ids = append(ids, h.UUID)
	}
	rows, err := s.Console.ListUnknown(ctx, a.OrgID, ids, domain.ReconcileBatch)
	if err != nil {
		return nil, contract.Internal("")
	}
	type entry struct {
		IntentID string `json:"intent_id"`
		RunID    string `json:"run_id"`
		OfferID  string `json:"offer_id"`
		Outcome  string `json:"outcome"`
		Reason   string `json:"reason"`
	}
	var skipped int64
	entries := make([]entry, 0, len(rows))
	for _, row := range rows {
		admitted, f := s.admit(ctx, a, row.StoreUUID)
		if f != nil {
			skipped++
			continue
		}
		kind, summary := domain.Observe(row.Kind, row.Body, s.fetch(ctx, contract.LaneRead, admitted.Secret))
		verdict := domain.Decide(kind, row.Passes, row.LastObservation, summary)
		if err := s.Console.ApplyProbe(ctx, a.OrgID, row.ID, verdict.State, summary, verdict.Code, summary, domain.ProbeBackoff(row.Passes)); err != nil {
			entries = append(entries, entry{IntentID: row.ID, RunID: row.Kind + ":" + itoa(row.StorePK), OfferID: row.Key, Outcome: "skipped", Reason: err.Error()})
			continue
		}
		outcome := "still_unknown"
		switch verdict.State {
		case "reconciled":
			outcome = "reconciled"
		case "conflict":
			outcome = "conflict"
		}
		entries = append(entries, entry{IntentID: row.ID, RunID: row.Kind + ":" + itoa(row.StorePK), OfferID: row.Key, Outcome: outcome, Reason: summary})
	}
	raw, _ := json.Marshal(struct {
		Skipped int64   `json:"skipped"`
		Entries []entry `json:"entries"`
	}{Skipped: skipped, Entries: entries})
	return envelope(raw), nil
}

func itoa(n int64) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(
		jsonNumber(n), "+", ""), " ", ""))
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
