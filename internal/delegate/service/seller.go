package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
)

// DB is the seller SQL the repository implements.
type DB interface {
	ListSources(ctx context.Context, orgID int64) ([]contract.Source, error)
	StoreGate(ctx context.Context, orgID, userID int64, canManage bool, storeID string) (string, error)
	VisibleStoreUUIDs(ctx context.Context, orgID, userID int64, canManage bool) ([]string, error)
	AdmitStore(ctx context.Context, orgID, userID int64, canManage bool, storeID string, nowMS int64) (contract.SealedCredential, error)
	ListBindings(ctx context.Context, orgID int64, storeID string) ([]contract.Binding, error)
	BindingStore(ctx context.Context, orgID, userID int64, canManage bool, bindingID string) (string, string, error)
	CreateBinding(ctx context.Context, orgID, userID int64, storeID, offerID, sourceID, note string, auto bool, nowMS int64) (contract.Binding, error)
	PatchBinding(ctx context.Context, orgID, userID int64, canManage bool, bindingID string, expected int64, sourceID, note *string, active *bool, auto bool, nowMS int64) (contract.Binding, error)
	DeleteBinding(ctx context.Context, orgID, userID int64, canManage bool, bindingID string, nowMS int64) error
	CommitAsset(ctx context.Context, orgID, userID int64, canManage bool, in contract.AssetIdentity, auto bool, nowMS int64, reload, reverify func() error) (contract.Asset, error)
	DeleteAsset(ctx context.Context, orgID, userID int64, canManage bool, assetID string, auto bool, nowMS int64) (contract.DeletedAsset, error)
	ListOrders(ctx context.Context, orgID int64, q contract.OrderQuery) ([]contract.Order, bool, string, error)
	GetOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string) (contract.Order, error)
	CreateOrder(ctx context.Context, orgID int64, in contract.CreateInput) (contract.Order, error)
	CancelOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string, nowMS int64) (contract.Order, error)
	CloseOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string, nowMS int64) (contract.Order, error)
	NudgeOrder(ctx context.Context, orgID, userID int64, canManage bool, orderID string, nowMS int64) (contract.Order, error)
	LoadMerge(ctx context.Context, orgID int64, storeID string) (contract.MergeSnapshot, error)
	PostingStates(ctx context.Context, orgID int64, storeID string, numbers []string) ([]contract.PostingHit, error)
}

// Issue is one browser PUT grant request.
type Issue struct {
	Key, ContentType, SHA, Purpose string
	Bytes                          uint64
	ActorID, WorkspaceID           int64
	Checksum                       bool
}

// Confirmed is the object read back from loopback storage.
type Confirmed struct {
	Key, SHA, ContentType string
	Bytes                 int64
}

// Edge is storage, tickets, and the Seller read. Nil methods mean that arm is unconfigured.
type Edge struct {
	Storage func(ctx context.Context) (prefix string, revision int64, err error)
	Issue   func(ctx context.Context, in Issue) (contract.UploadTarget, error)
	Confirm func(ctx context.Context, purpose string, actorID, orgID int64, token string) (Confirmed, error)
	Delete  func(ctx context.Context, key string) error
	Seller  func(ctx context.Context, clientID, apiKey, path string, body []byte) (status int, resp []byte, kind string, err error)
	Open    func(cred contract.SealedCredential) (clientID, apiKey string, err error)
}

// Seller is the 16 seller routes. Supplier accept/reject/ship stay on Service.
type Seller struct {
	DB   DB
	Edge Edge
	Auto bool
	Now  func() time.Time
}

func (s Seller) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s Seller) millis() int64 { return s.now().UTC().UnixMilli() }

type sessionRecheckKey struct{}

// WithSessionRecheck attaches the second require_tenant that finalize runs
// after the object is read and before the row is committed.
func WithSessionRecheck(ctx context.Context, fn func() (userID, orgID int64, err error)) context.Context {
	return context.WithValue(ctx, sessionRecheckKey{}, fn)
}

func recheckSession(ctx context.Context, actor Actor) error {
	fn, _ := ctx.Value(sessionRecheckKey{}).(func() (int64, int64, error))
	if fn == nil {
		return nil
	}
	userID, orgID, err := fn()
	if err != nil {
		return err
	}
	if userID != actor.UserID || orgID != actor.OrgID {
		return contract.Forbidden("上传期间登录或工作空间已变化")
	}
	return nil
}

func asAPI(err error) error {
	if err == nil {
		return nil
	}
	var api *contract.APIError
	if errors.As(err, &api) {
		return err
	}
	if errors.Is(err, contract.ErrUnavailable) {
		return contract.Internal()
	}
	return contract.Internal()
}

// Actor is the session the handler already checked.
type Actor struct {
	UserID    int64
	OrgID     int64
	Role      string
	CanManage bool
}

func (s Seller) Sources(ctx context.Context, actor Actor) ([]contract.Source, error) {
	rows, err := s.DB.ListSources(ctx, actor.OrgID)
	return rows, asAPI(err)
}

func (s Seller) Bindings(ctx context.Context, actor Actor, storeID string) ([]contract.Binding, error) {
	store, err := s.DB.StoreGate(ctx, actor.OrgID, actor.UserID, actor.CanManage, storeID)
	if err != nil {
		return nil, asAPI(err)
	}
	rows, err := s.DB.ListBindings(ctx, actor.OrgID, store)
	return rows, asAPI(err)
}

func (s Seller) CreateBinding(ctx context.Context, actor Actor, storeID, offerID, sourceID, note string) (contract.Binding, error) {
	store, err := s.DB.StoreGate(ctx, actor.OrgID, actor.UserID, actor.CanManage, storeID)
	if err != nil {
		return contract.Binding{}, asAPI(err)
	}
	offer, ok := domain.NormalizeOfferID(offerID)
	if !ok {
		return contract.Binding{}, contract.Validation("offer_id 不能为空")
	}
	note, err = domain.BindingNote(note)
	if err != nil {
		return contract.Binding{}, err
	}
	sourceID = strings.TrimSpace(sourceID)
	if sourceID == "" {
		return contract.Binding{}, contract.Validation("请选择厂家")
	}
	row, err := s.DB.CreateBinding(ctx, actor.OrgID, actor.UserID, store, offer, sourceID, note, s.Auto, s.millis())
	return row, asAPI(err)
}

func (s Seller) PatchBinding(ctx context.Context, actor Actor, bindingID string, expected int64, sourceID, note *string, active *bool) (contract.Binding, error) {
	if _, ok := domain.NormalizeUUID(bindingID); !ok {
		return contract.Binding{}, contract.NotFound("绑定不存在")
	}
	if expected < 1 {
		return contract.Binding{}, contract.Validation("expectedRevision 无效")
	}
	if note != nil {
		normalized, err := domain.BindingNote(*note)
		if err != nil {
			return contract.Binding{}, err
		}
		note = &normalized
	}
	if sourceID != nil {
		trimmed := strings.TrimSpace(*sourceID)
		if trimmed == "" {
			sourceID = nil
		} else {
			sourceID = &trimmed
		}
	}
	if sourceID == nil && note == nil && active == nil {
		return contract.Binding{}, contract.Validation("没有需要更新的字段")
	}
	row, err := s.DB.PatchBinding(ctx, actor.OrgID, actor.UserID, actor.CanManage, bindingID, expected, sourceID, note, active, s.Auto, s.millis())
	return row, asAPI(err)
}

func (s Seller) DeleteBinding(ctx context.Context, actor Actor, bindingID string) error {
	if _, ok := domain.NormalizeUUID(bindingID); !ok {
		return contract.NotFound("绑定不存在")
	}
	return asAPI(s.DB.DeleteBinding(ctx, actor.OrgID, actor.UserID, actor.CanManage, bindingID, s.millis()))
}

func (s Seller) Presign(ctx context.Context, actor Actor, bindingID, sha, mime, fileName string, bytes int64, checksum bool) (contract.UploadTarget, error) {
	id, ok := domain.NormalizeUUID(bindingID)
	if !ok {
		return contract.UploadTarget{}, contract.NotFound("绑定不存在")
	}
	ext, normalized, err := domain.ValidateFile(sha, mime, fileName, bytes)
	if err != nil {
		return contract.UploadTarget{}, err
	}
	storeID, _, err := s.DB.BindingStore(ctx, actor.OrgID, actor.UserID, actor.CanManage, id)
	if err != nil {
		return contract.UploadTarget{}, asAPI(err)
	}
	if s.Edge.Storage == nil || s.Edge.Issue == nil {
		return contract.UploadTarget{}, contract.StorageUnavailable(contract.MsgStorageMissing)
	}
	prefix, _, err := s.Edge.Storage(ctx)
	if err != nil {
		return contract.UploadTarget{}, asAPI(err)
	}
	prefix, err = domain.NormalizePrefix(prefix)
	if err != nil {
		return contract.UploadTarget{}, contract.StorageUnavailable("委托原图存储桶 keyPrefix 非法")
	}
	key := domain.AssetKey(prefix, actor.OrgID, normalized, ext)
	target, err := s.Edge.Issue(ctx, Issue{
		Key: key, ContentType: strings.TrimSpace(mime), SHA: normalized,
		Purpose: domain.Purpose(id, storeID), Bytes: uint64(bytes),
		ActorID: actor.UserID, WorkspaceID: actor.OrgID, Checksum: checksum,
	})
	return target, asAPI(err)
}

func (s Seller) Finalize(ctx context.Context, actor Actor, bindingID, ticket, fileName string, position int32) (contract.Asset, error) {
	id, ok := domain.NormalizeUUID(bindingID)
	if !ok {
		return contract.Asset{}, contract.NotFound("绑定不存在")
	}
	storeID, _, err := s.DB.BindingStore(ctx, actor.OrgID, actor.UserID, actor.CanManage, id)
	if err != nil {
		return contract.Asset{}, asAPI(err)
	}
	if s.Edge.Storage == nil || s.Edge.Confirm == nil {
		return contract.Asset{}, contract.StorageUnavailable(contract.MsgStorageMissing)
	}
	prefix, revision, err := s.Edge.Storage(ctx)
	if err != nil {
		return contract.Asset{}, asAPI(err)
	}
	prefix, err = domain.NormalizePrefix(prefix)
	if err != nil {
		return contract.Asset{}, contract.StorageUnavailable("委托原图存储桶 keyPrefix 非法")
	}
	purpose := domain.Purpose(id, storeID)
	confirmed, err := s.Edge.Confirm(ctx, purpose, actor.UserID, actor.OrgID, ticket)
	if err != nil {
		var api *contract.APIError
		if errors.As(err, &api) && api.Status == 409 {
			return contract.Asset{}, contract.Unprocessable("文件内容与上传授权不符，请勿覆盖该对象")
		}
		return contract.Asset{}, asAPI(err)
	}
	ext, sha, err := domain.ValidateFile(confirmed.SHA, confirmed.ContentType, fileName, confirmed.Bytes)
	if err != nil {
		return contract.Asset{}, err
	}
	if err := domain.KeyMatchesReceipt(confirmed.Key, prefix, actor.OrgID, sha, ext); err != nil {
		return contract.Asset{}, err
	}
	if err := recheckSession(ctx, actor); err != nil {
		return contract.Asset{}, err
	}
	asset, err := s.DB.CommitAsset(ctx, actor.OrgID, actor.UserID, actor.CanManage, contract.AssetIdentity{
		Key: confirmed.Key, SHA: sha, Mime: strings.TrimSpace(confirmed.ContentType), FileName: strings.TrimSpace(fileName),
		BindingID: id, StoreID: storeID, Bytes: confirmed.Bytes, Position: position,
	}, s.Auto, s.millis(), func() error {
		nextPrefix, nextRevision, err := s.Edge.Storage(ctx)
		if err != nil {
			return err
		}
		if nextRevision != revision || nextPrefix != prefix {
			return contract.Conflict("存储配置已变化，请重新授权上传")
		}
		return nil
	}, func() error {
		_, err := s.Edge.Confirm(ctx, purpose, actor.UserID, actor.OrgID, ticket)
		return err
	})
	return asset, asAPI(err)
}

func (s Seller) DeleteAsset(ctx context.Context, actor Actor, assetID string) (string, bool, error) {
	id, ok := domain.NormalizeUUID(assetID)
	if !ok {
		return "", false, contract.NotFound("素材不存在")
	}
	deleted, err := s.DB.DeleteAsset(ctx, actor.OrgID, actor.UserID, actor.CanManage, id, s.Auto, s.millis())
	if err != nil {
		return "", false, asAPI(err)
	}
	if deleted.Reclaimed {
		if s.Edge.Storage == nil {
			return "", false, contract.StorageUnavailable(contract.MsgStorageMissing)
		}
		if _, _, err := s.Edge.Storage(ctx); err != nil {
			return "", false, asAPI(err)
		}
		if s.Edge.Delete != nil {
			_ = s.Edge.Delete(ctx, deleted.ObjectKey)
		}
	}
	return deleted.AssetID, deleted.Reclaimed, nil
}

func (s Seller) Orders(ctx context.Context, actor Actor, storeID, state, cursor string, limit *int64) ([]contract.Order, bool, string, error) {
	q := contract.OrderQuery{State: strings.TrimSpace(state), Limit: domain.PageLimit(limit)}
	if strings.TrimSpace(cursor) != "" {
		ms, id, ok := domain.DecodeCursor(strings.TrimSpace(cursor))
		if !ok {
			return nil, false, "", contract.Validation("cursor 无效")
		}
		q.CursorMS = &ms
		q.CursorOrderID = id
	}
	if strings.TrimSpace(storeID) != "" {
		store, err := s.DB.StoreGate(ctx, actor.OrgID, actor.UserID, actor.CanManage, storeID)
		if err != nil {
			return nil, false, "", asAPI(err)
		}
		q.Stores = []string{store}
	} else if actor.CanManage {
		q.AllStores = true
	} else {
		stores, err := s.DB.VisibleStoreUUIDs(ctx, actor.OrgID, actor.UserID, false)
		if err != nil {
			return nil, false, "", asAPI(err)
		}
		if len(stores) == 0 {
			return []contract.Order{}, false, "", nil
		}
		q.Stores = stores
	}
	orders, hasNext, next, err := s.DB.ListOrders(ctx, actor.OrgID, q)
	return orders, hasNext, next, asAPI(err)
}

func (s Seller) Order(ctx context.Context, actor Actor, orderID string) (contract.Order, error) {
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return contract.Order{}, contract.NotFound("委托单不存在")
	}
	row, err := s.DB.GetOrder(ctx, actor.OrgID, actor.UserID, actor.CanManage, id)
	return row, asAPI(err)
}

func (s Seller) CreateOrder(ctx context.Context, actor Actor, storeID, postingNumber, sellerNote, idempotency string, offerIDs []string, offerIDsSet bool) (contract.Order, error) {
	cred, err := s.DB.AdmitStore(ctx, actor.OrgID, actor.UserID, actor.CanManage, storeID, s.millis())
	if err != nil {
		return contract.Order{}, asAPI(err)
	}
	clientID, apiKey, err := s.open(cred)
	if err != nil {
		return contract.Order{}, asAPI(err)
	}
	postingNumber = strings.TrimSpace(postingNumber)
	if postingNumber == "" {
		return contract.Order{}, contract.Validation("posting_number 不能为空")
	}
	sellerNote, err = domain.SellerNote(sellerNote)
	if err != nil {
		return contract.Order{}, err
	}
	lines, snapshot, err := s.findPosting(ctx, clientID, apiKey, postingNumber)
	if err != nil {
		return contract.Order{}, err
	}
	logistics, _ := s.logistics(ctx, clientID, apiKey, postingNumber)
	row, err := s.DB.CreateOrder(ctx, actor.OrgID, contract.CreateInput{
		StoreID: cred.StoreUUID, PostingNumber: postingNumber, SellerNote: sellerNote, IdempotencyKey: idempotency,
		Snapshot: snapshot, Logistics: logistics, Lines: lines, OfferIDs: offerIDs, OfferIDsSet: offerIDsSet,
		Auto: s.Auto, NowMS: s.millis(), UserID: actor.UserID, CanManage: actor.CanManage,
	})
	return row, asAPI(err)
}

func (s Seller) findPosting(ctx context.Context, clientID, apiKey, postingNumber string) ([]contract.CreateLine, []byte, error) {
	from, to := domain.ListWindow(s.now(), domain.LookbackDays)
	cursor := ""
	for page := 0; page < domain.LookbackPages; page++ {
		body, err := domain.UnfulfilledBody(cursor, from, to, 100)
		if err != nil {
			return nil, nil, contract.Internal()
		}
		raw, err := s.seller(ctx, clientID, apiKey, "/v4/posting/fbs/unfulfilled/list", body, "读取 FBS 待发货单")
		if err != nil {
			return nil, nil, err
		}
		postings, next, hasNext, err := domain.ParseUnfulfilled(raw)
		if err != nil {
			return nil, nil, contract.Upstream(domain.SellerReadMessage("读取 FBS 待发货单", "/v4/posting/fbs/unfulfilled/list", 0, "decode"))
		}
		for _, posting := range postings {
			if posting.PostingNumber != postingNumber {
				continue
			}
			lines := domain.AssembleLines(posting.Products)
			out := make([]contract.CreateLine, len(lines))
			for i, line := range lines {
				out[i] = contract.CreateLine{OfferID: line.OfferID, SKU: line.SKU, Name: line.Name, Quantity: line.Quantity}
			}
			snap, err := json.Marshal(struct {
				Status      string `json:"status"`
				Substatus   string `json:"substatus"`
				InProcessAt string `json:"in_process_at"`
				Shipment    string `json:"shipment_date"`
			}{posting.Status, posting.Substatus, posting.InProcessAt, posting.ShipmentDate})
			if err != nil {
				return nil, nil, contract.Internal()
			}
			return out, snap, nil
		}
		if !hasNext {
			break
		}
		cursor = next
	}
	return nil, nil, contract.NotFound("未在未履约列表中找到该订单，请确认订单号与时间窗")
}

func (s Seller) logistics(ctx context.Context, clientID, apiKey, postingNumber string) ([]byte, error) {
	body, err := domain.GetV3Body(postingNumber)
	if err != nil {
		return nil, err
	}
	raw, err := s.seller(ctx, clientID, apiKey, "/v3/posting/fbs/get", body, "读取 FBS 待发货单")
	if err != nil {
		return nil, nil
	}
	view, err := domain.LogisticsFromV3(raw)
	if err != nil {
		return nil, nil
	}
	return json.Marshal(view)
}

func (s Seller) Postings(ctx context.Context, actor Actor, storeID string, windowDays, limit int64, cursor string) (string, []contract.PostingView, bool, string, error) {
	windowDays = domain.ClampLimit(windowDays, domain.MaxWindowDays)
	limit = domain.ClampLimit(limit, domain.MaxPostingLimit)
	cred, err := s.DB.AdmitStore(ctx, actor.OrgID, actor.UserID, actor.CanManage, storeID, s.millis())
	if err != nil {
		return "", nil, false, "", asAPI(err)
	}
	clientID, apiKey, err := s.open(cred)
	if err != nil {
		return "", nil, false, "", asAPI(err)
	}
	from, to := domain.ListWindow(s.now(), windowDays)
	body, err := domain.UnfulfilledBody(cursor, from, to, limit)
	if err != nil {
		return "", nil, false, "", contract.Internal()
	}
	raw, err := s.seller(ctx, clientID, apiKey, "/v4/posting/fbs/unfulfilled/list", body, "读取 FBS 待发货单")
	if err != nil {
		return "", nil, false, "", err
	}
	postings, next, hasNext, err := domain.ParseUnfulfilled(raw)
	if err != nil {
		return "", nil, false, "", contract.Upstream(domain.SellerReadMessage("读取 FBS 待发货单", "/v4/posting/fbs/unfulfilled/list", 0, "decode"))
	}
	domain.SortPostings(postings)
	merge, err := s.DB.LoadMerge(ctx, actor.OrgID, cred.StoreUUID)
	if err != nil {
		return "", nil, false, "", asAPI(err)
	}
	ready := map[string]struct{}{}
	for _, offer := range merge.Ready {
		ready[offer] = struct{}{}
	}
	orders := map[string]domain.OpenOrder{}
	for _, order := range merge.Orders {
		offers := map[string]struct{}{}
		for _, offer := range order.Offers {
			offers[strings.TrimSpace(offer)] = struct{}{}
		}
		orders[order.PostingNumber] = domain.OpenOrder{OrderID: order.OrderID, State: order.State, Offers: offers}
	}
	views := make([]contract.PostingView, 0, len(postings))
	for _, posting := range postings {
		var open *domain.OpenOrder
		if order, ok := orders[posting.PostingNumber]; ok {
			open = &order
		}
		state, covered, orderID, orderState := domain.MergeState(posting.Products, open, ready)
		view := contract.PostingView{
			PostingNumber: posting.PostingNumber, InProcessAt: posting.InProcessAt, ShipmentDate: posting.ShipmentDate,
			Status: posting.Status, Substatus: posting.Substatus, DelegateState: state, CoveredLines: covered, TotalLines: int64(len(posting.Products)),
		}
		for _, product := range posting.Products {
			view.Products = append(view.Products, contract.PostingProductView{SKU: product.SKU, OfferID: product.OfferID, Name: product.Name, Quantity: product.Quantity})
			view.Quantity += product.Quantity
		}
		if view.Products == nil {
			view.Products = []contract.PostingProductView{}
		}
		if orderID != "" {
			view.OrderID = &orderID
			view.OrderState = &orderState
		}
		views = append(views, view)
	}
	return cred.StoreUUID, views, hasNext, next, nil
}

func (s Seller) PostingStates(ctx context.Context, actor Actor, storeID, numbers string) (string, []contract.PostingStateView, error) {
	store, err := s.DB.StoreGate(ctx, actor.OrgID, actor.UserID, actor.CanManage, storeID)
	if err != nil {
		return "", nil, asAPI(err)
	}
	wanted := domain.SplitPostingNumbers(numbers)
	if len(wanted) == 0 {
		return store, []contract.PostingStateView{}, nil
	}
	hits, err := s.DB.PostingStates(ctx, actor.OrgID, store, wanted)
	if err != nil {
		return "", nil, asAPI(err)
	}
	by := map[string]contract.PostingHit{}
	for _, hit := range hits {
		by[hit.PostingNumber] = hit
	}
	out := make([]contract.PostingStateView, 0, len(wanted))
	for _, number := range wanted {
		view := contract.PostingStateView{PostingNumber: number, State: "none", CoveredOfferIDs: []string{}}
		if hit, ok := by[number]; ok {
			view.State = "delegated"
			view.CoveredOfferIDs = domain.CoverOffers(hit.Offers)
			id, state := hit.OrderID, hit.State
			view.OrderID = &id
			view.OrderState = &state
		}
		out = append(out, view)
	}
	return store, out, nil
}

func (s Seller) Cancel(ctx context.Context, actor Actor, orderID string) (contract.Order, error) {
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return contract.Order{}, contract.NotFound("委托单不存在")
	}
	row, err := s.DB.CancelOrder(ctx, actor.OrgID, actor.UserID, actor.CanManage, id, s.millis())
	return row, asAPI(err)
}

func (s Seller) Close(ctx context.Context, actor Actor, orderID string) (contract.Order, error) {
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return contract.Order{}, contract.NotFound("委托单不存在")
	}
	row, err := s.DB.CloseOrder(ctx, actor.OrgID, actor.UserID, actor.CanManage, id, s.millis())
	return row, asAPI(err)
}

func (s Seller) Nudge(ctx context.Context, actor Actor, orderID string) (contract.Order, error) {
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return contract.Order{}, contract.NotFound("委托单不存在")
	}
	row, err := s.DB.NudgeOrder(ctx, actor.OrgID, actor.UserID, actor.CanManage, id, s.millis())
	return row, asAPI(err)
}

func (s Seller) open(cred contract.SealedCredential) (string, string, error) {
	if s.Edge.Open == nil {
		return "", "", contract.Internal()
	}
	return s.Edge.Open(cred)
}

func (s Seller) seller(ctx context.Context, clientID, apiKey, path string, body []byte, operation string) ([]byte, error) {
	if s.Edge.Seller == nil {
		return nil, contract.Upstream(domain.SellerReadMessage(operation, path, 0, "connect"))
	}
	status, resp, kind, err := s.Edge.Seller(ctx, clientID, apiKey, path, body)
	if err != nil || kind == "timeout" || kind == "connect" {
		if kind == "" {
			kind = "connect"
		}
		if kind == "timeout" || kind == "connect" || kind == "decode" {
			return nil, contract.Upstream(domain.SellerReadMessage(operation, path, status, kind))
		}
		return nil, contract.Upstream(domain.SellerReadMessage(operation, path, status, "connect"))
	}
	if status == 429 {
		return nil, contract.RateLimited()
	}
	if status >= 400 {
		return nil, contract.Upstream(domain.SellerReadMessage(operation, path, status, "http"))
	}
	return resp, nil
}
