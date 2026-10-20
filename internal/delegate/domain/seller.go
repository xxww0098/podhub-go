// Seller-route decisions copied from the Rust delegate handlers.
// These functions do not touch the database or the network.
package domain

import (
	"crypto/rand"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

const (
	// MaxAssetBytes is plan::MAX_ASSET_BYTES.
	MaxAssetBytes int64 = 500 * 1024 * 1024
	// MaxBindingNoteChars is bindings::MAX_NOTE_CHARS.
	MaxBindingNoteChars = 2000
	// MaxSellerNoteChars is orders::MAX_NOTE_CHARS.
	MaxSellerNoteChars = 1000
	// MaxIdempotencyChars is orders::MAX_IDEMPOTENCY_CHARS.
	MaxIdempotencyChars = 64
	// MaxWindowDays is postings::MAX_WINDOW_DAYS.
	MaxWindowDays int64 = 180
	// MaxPostingLimit is postings::MAX_LIMIT.
	MaxPostingLimit int64 = 100
	// MaxPostingNumbers is postings::MAX_POSTING_NUMBERS.
	MaxPostingNumbers = 200
	// DefaultPageLimit is orders::DEFAULT_PAGE_LIMIT.
	DefaultPageLimit int64 = 20
	// MaxPageLimit is orders::MAX_PAGE_LIMIT.
	MaxPageLimit int64 = 50
	// NudgeCooldownMS is 30 minutes.
	NudgeCooldownMS int64 = 30 * 60 * 1000
	// LookbackDays is the create-order unfulfilled window.
	LookbackDays int64 = 30
	// LookbackPages is LOOKBACK_MAX_PAGES.
	LookbackPages = 10
)

// AssetExtension is plan::asset_extension. jpeg folds to jpg.
func AssetExtension(fileName string) (string, bool) {
	name := strings.TrimSpace(fileName)
	dot := strings.LastIndex(name, ".")
	if dot < 0 || dot == len(name)-1 {
		return "", false
	}
	switch strings.ToLower(name[dot+1:]) {
	case "jpg", "jpeg":
		return "jpg", true
	case "png":
		return "png", true
	case "webp":
		return "webp", true
	case "psd":
		return "psd", true
	default:
		return "", false
	}
}

// MimeMatchesExtension is plan::mime_matches_extension.
func MimeMatchesExtension(mime, extension string) bool {
	mime = strings.TrimSpace(mime)
	if mime == "" || len(mime) > 128 {
		return false
	}
	if extension == "psd" {
		return true
	}
	return strings.HasPrefix(mime, "image/")
}

// ValidateFile is assets_policy::validate_file.
func ValidateFile(sha, mime, fileName string, bytes int64) (ext, normalized string, err error) {
	normalized = strings.ToLower(strings.TrimSpace(sha))
	if len(normalized) != 64 || !hex64(normalized) {
		return "", "", contract.Validation("sha256 无效")
	}
	if bytes < 1 || bytes > MaxAssetBytes {
		return "", "", contract.Validation("文件大小需在 1–524288000 字节之间")
	}
	ext, ok := AssetExtension(fileName)
	if !ok {
		return "", "", contract.Validation("只支持 jpg/png/webp/psd 原图文件")
	}
	if !MimeMatchesExtension(mime, ext) {
		return "", "", contract.Validation("文件类型与内容不符")
	}
	return ext, normalized, nil
}

func hex64(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// NormalizePrefix matches media objectkey.NormalizePrefix. Delegate does not
// import that package. Empty becomes "". A trailing slash is kept when set.
func NormalizePrefix(value string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(value), "/")
	if trimmed == "" {
		return "", nil
	}
	if strings.Contains(trimmed, `\`) {
		return "", contract.Validation("委托原图存储桶 keyPrefix 非法")
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", contract.Validation("委托原图存储桶 keyPrefix 非法")
		}
	}
	return trimmed + "/", nil
}

// AssetKey is {prefix}{org}/{sha256}.{ext}.
func AssetKey(prefix string, orgID int64, sha, ext string) string {
	return prefix + strconv.FormatInt(orgID, 10) + "/" + sha + "." + ext
}

// ParseAssetKey checks the org segment. A bad shape is 400. Another org is 409.
func ParseAssetKey(key, prefix string, orgID int64) error {
	rest := key
	if prefix != "" {
		if !strings.HasPrefix(key, prefix) {
			return contract.Validation("对象键无效")
		}
		rest = strings.TrimPrefix(key, prefix)
	}
	org, file, ok := strings.Cut(rest, "/")
	if !ok || strings.Contains(file, "/") || org == "" || file == "" {
		return contract.Validation("对象键无效")
	}
	if org != strconv.FormatInt(orgID, 10) {
		return contract.Conflict("对象键不属于当前工作空间")
	}
	return nil
}

// KeyMatchesReceipt is the 422 when the object key disagrees with the file claim.
func KeyMatchesReceipt(key, prefix string, orgID int64, sha, ext string) error {
	if err := ParseAssetKey(key, prefix, orgID); err != nil {
		return err
	}
	if key != AssetKey(prefix, orgID, sha, ext) {
		return contract.Unprocessable("对象键与文件内容声明不一致")
	}
	return nil
}

// ReplayAsset is ensure_replay_identity.
func ReplayAsset(existingBinding, binding, sha, mime string, bytes int64, verifiedAt *int64, wantSHA, wantMime string, wantBytes int64) error {
	if existingBinding != binding {
		return contract.Conflict("同一对象已属于其他绑定，不可重新指派")
	}
	if verifiedAt == nil || sha != wantSHA || bytes != wantBytes || mime != wantMime {
		return contract.Conflict("已有素材身份与确认回执不一致")
	}
	return nil
}

// NormalizeOfferID is NULLIF(btrim(offer_id), ”).
func NormalizeOfferID(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// BindingNote trims and enforces 2000 characters.
func BindingNote(note string) (string, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > MaxBindingNoteChars {
		return "", contract.Validation("备注不能超过 2000 个字符")
	}
	return note, nil
}

// SellerNote trims and enforces 1000 characters.
func SellerNote(note string) (string, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > MaxSellerNoteChars {
		return "", contract.Validation("随单备注不能超过 1000 个字符")
	}
	return note, nil
}

// IdempotencyKey trims the header. Non-UTF-8 and empty share one message.
func IdempotencyKey(raw string, validUTF8 bool) (string, error) {
	if !validUTF8 {
		return "", contract.Validation("缺少 Idempotency-Key 头")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", contract.Validation("缺少 Idempotency-Key 头")
	}
	if utf8.RuneCountInString(raw) > MaxIdempotencyChars {
		return "", contract.Validation("幂等键须为 1–64 个字符")
	}
	return raw, nil
}

// ClampLimit clamps to [1, max]. Zero and negative become 1.
func ClampLimit(n, max int64) int64 {
	if n < 1 {
		return 1
	}
	if n > max {
		return max
	}
	return n
}

// PageLimit defaults a missing limit to 20 and clamps to 1..50.
func PageLimit(n *int64) int64 {
	if n == nil {
		return DefaultPageLimit
	}
	return ClampLimit(*n, MaxPageLimit)
}

// NormalizeUUID is Uuid::parse_str + to_string. Failure is the caller's 404.
func NormalizeUUID(raw string) (string, bool) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	return id.String(), true
}

// CanManage is owner or manager. admin is stored as manager. Empty and unknown fail.
func CanManage(role string) (manage bool, err error) {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "":
		return false, contract.Forbidden(contract.MsgNoWorkspace)
	case "owner":
		return true, nil
	case "manager", "admin":
		return true, nil
	case "member", "reviewer", "viewer":
		return false, nil
	default:
		return false, contract.Forbidden("工作空间角色无效")
	}
}

// MemberWarning is the advisory when the factory has no active account.
func MemberWarning(activeMembers int64) *string {
	if activeMembers != 0 {
		return nil
	}
	msg := "该厂家暂无可用账号，派发包会先排队等待"
	return &msg
}

// Cursor is created_at_ms:order_id. The order id is the first cut's remainder.
func EncodeCursor(createdAtMS int64, orderID string) string {
	return strconv.FormatInt(createdAtMS, 10) + ":" + orderID
}

// DecodeCursor rejects a missing colon, a non-integer prefix, or a bad uuid.
func DecodeCursor(raw string) (int64, string, bool) {
	msRaw, id, ok := strings.Cut(raw, ":")
	if !ok || msRaw == "" || id == "" {
		return 0, "", false
	}
	ms, err := strconv.ParseInt(msRaw, 10, 64)
	if err != nil {
		return 0, "", false
	}
	parsed, ok := NormalizeUUID(id)
	if !ok {
		return 0, "", false
	}
	return ms, parsed, true
}

// ProjectSnapshot keeps status, substatus, in_process_at, shipment_date.
func ProjectSnapshot(raw json.RawMessage) json.RawMessage {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return json.RawMessage(`{}`)
	}
	type snap struct {
		Status      json.RawMessage `json:"status,omitempty"`
		Substatus   json.RawMessage `json:"substatus,omitempty"`
		InProcessAt json.RawMessage `json:"in_process_at,omitempty"`
		Shipment    json.RawMessage `json:"shipment_date,omitempty"`
	}
	out := snap{
		Status:      obj["status"],
		Substatus:   obj["substatus"],
		InProcessAt: obj["in_process_at"],
		Shipment:    obj["shipment_date"],
	}
	buf, err := json.Marshal(out)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return buf
}

// Logistics whitelist. Empty strings stay in the object.
type Logistics struct {
	Warehouse         string `json:"warehouse"`
	DeliveryMethod    string `json:"delivery_method"`
	DeliveryType      string `json:"delivery_type"`
	TplProvider       string `json:"tpl_provider"`
	City              string `json:"city"`
	Region            string `json:"region"`
	DeliveryDateBegin string `json:"delivery_date_begin"`
	DeliveryDateEnd   string `json:"delivery_date_end"`
	ShipmentDate      string `json:"shipment_date"`
}

// LogisticsFromV3 builds the whitelist. A missing analytics or delivery field is "".
func LogisticsFromV3(raw json.RawMessage) (Logistics, error) {
	body := unwrapResult(raw)
	var doc struct {
		ShipmentDate  string `json:"shipment_date"`
		AnalyticsData *struct {
			Warehouse         string  `json:"warehouse"`
			City              string  `json:"city"`
			Region            string  `json:"region"`
			DeliveryType      string  `json:"delivery_type"`
			TplProvider       string  `json:"tpl_provider"`
			DeliveryDateBegin *string `json:"delivery_date_begin"`
			DeliveryDateEnd   *string `json:"delivery_date_end"`
		} `json:"analytics_data"`
		DeliveryMethod *struct {
			Name        string `json:"name"`
			Warehouse   string `json:"warehouse"`
			TplProvider string `json:"tpl_provider"`
		} `json:"delivery_method"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return Logistics{}, err
	}
	pick := func(a, b string) string {
		if strings.TrimSpace(a) != "" {
			return a
		}
		if strings.TrimSpace(b) != "" {
			return b
		}
		return ""
	}
	var aWarehouse, aCity, aRegion, aType, aTpl, aBegin, aEnd string
	if doc.AnalyticsData != nil {
		aWarehouse = doc.AnalyticsData.Warehouse
		aCity = doc.AnalyticsData.City
		aRegion = doc.AnalyticsData.Region
		aType = doc.AnalyticsData.DeliveryType
		aTpl = doc.AnalyticsData.TplProvider
		if doc.AnalyticsData.DeliveryDateBegin != nil {
			aBegin = *doc.AnalyticsData.DeliveryDateBegin
		}
		if doc.AnalyticsData.DeliveryDateEnd != nil {
			aEnd = *doc.AnalyticsData.DeliveryDateEnd
		}
	}
	var dName, dWarehouse, dTpl string
	if doc.DeliveryMethod != nil {
		dName = doc.DeliveryMethod.Name
		dWarehouse = doc.DeliveryMethod.Warehouse
		dTpl = doc.DeliveryMethod.TplProvider
	}
	return Logistics{
		Warehouse:         pick(aWarehouse, dWarehouse),
		DeliveryMethod:    pick(dName, aType),
		DeliveryType:      aType,
		TplProvider:       pick(aTpl, dTpl),
		City:              aCity,
		Region:            aRegion,
		DeliveryDateBegin: aBegin,
		DeliveryDateEnd:   aEnd,
		ShipmentDate:      doc.ShipmentDate,
	}, nil
}

func unwrapResult(raw json.RawMessage) json.RawMessage {
	var wrap struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &wrap); err == nil && len(wrap.Result) > 0 && wrap.Result[0] == '{' {
		return wrap.Result
	}
	return raw
}

// PostingProduct is one Ozon line after trim rules are applied by the caller.
type PostingProduct struct {
	SKU      int64
	OfferID  string
	Name     string
	Quantity int32
}

// Posting is one unfulfilled posting.
type Posting struct {
	PostingNumber string
	InProcessAt   string
	ShipmentDate  string
	Status        string
	Substatus     string
	Products      []PostingProduct
}

// AssembleLines drops blank offers, keeps the first of a duplicate, and floors quantity at 1.
func AssembleLines(products []PostingProduct) []PostingProduct {
	seen := map[string]bool{}
	var out []PostingProduct
	for _, product := range products {
		offer := strings.TrimSpace(product.OfferID)
		if offer == "" || seen[offer] {
			continue
		}
		seen[offer] = true
		qty := product.Quantity
		if qty < 1 {
			qty = 1
		}
		product.OfferID = offer
		product.Quantity = qty
		out = append(out, product)
	}
	return out
}

// SelectLines applies offer_ids. Nil means every assembled line.
// An empty selection is 422. Unknown offers are 422 in sorted order.
func SelectLines(lines []PostingProduct, offerIDs []string, offerIDsSet bool) ([]PostingProduct, error) {
	if !offerIDsSet {
		if len(lines) == 0 {
			return nil, contract.Unprocessable("订单里没有可委托的商品行")
		}
		return lines, nil
	}
	selected := map[string]struct{}{}
	var ordered []string
	for _, raw := range offerIDs {
		offer, ok := NormalizeOfferID(raw)
		if !ok {
			continue
		}
		if _, seen := selected[offer]; seen {
			continue
		}
		selected[offer] = struct{}{}
		ordered = append(ordered, offer)
	}
	sort.Strings(ordered)
	wanted := map[string]PostingProduct{}
	for _, line := range lines {
		if _, ok := selected[line.OfferID]; ok {
			if _, seen := wanted[line.OfferID]; !seen {
				wanted[line.OfferID] = line
			}
		}
	}
	if len(wanted) < len(selected) {
		var missing []string
		for _, offer := range ordered {
			if _, ok := wanted[offer]; !ok {
				missing = append(missing, offer)
			}
		}
		return nil, contract.Unprocessable("所选商品不在该订单中：" + strings.Join(missing, ", "))
	}
	if len(wanted) == 0 {
		return nil, contract.Unprocessable("订单里没有可委托的商品行")
	}
	var out []PostingProduct
	for _, line := range lines {
		if picked, ok := wanted[line.OfferID]; ok {
			out = append(out, picked)
			delete(wanted, line.OfferID)
		}
	}
	return out, nil
}

// OpenOrder is one non-terminal delegate order used by merge_posting.
type OpenOrder struct {
	OrderID string
	State   string
	Offers  map[string]struct{}
}

// MergeState is delegated, partial, ready, or needs_setup.
func MergeState(products []PostingProduct, order *OpenOrder, ready map[string]struct{}) (state string, covered int64, orderID, orderState string) {
	total := int64(len(products))
	if order != nil {
		for _, product := range products {
			if _, ok := order.Offers[strings.TrimSpace(product.OfferID)]; ok {
				covered++
			}
		}
		state = "partial"
		if covered >= total && total > 0 {
			state = "delegated"
		}
		return state, covered, order.OrderID, order.State
	}
	allReady := len(products) > 0
	for _, product := range products {
		if _, ok := ready[strings.TrimSpace(product.OfferID)]; !ok {
			allReady = false
			break
		}
	}
	if allReady {
		return "ready", 0, "", ""
	}
	return "needs_setup", 0, "", ""
}

// SortPostings orders by shipment_date then posting_number. It is stable.
func SortPostings(rows []Posting) {
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].ShipmentDate != rows[j].ShipmentDate {
			return rows[i].ShipmentDate < rows[j].ShipmentDate
		}
		return rows[i].PostingNumber < rows[j].PostingNumber
	})
}

// Badge is none or delegated. Any open order, including partial coverage, is delegated.
func Badge(hasOrder bool) string {
	if hasOrder {
		return "delegated"
	}
	return "none"
}

// CoverOffers trims, drops empty, sorts, and dedupes.
func CoverOffers(raw []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, item := range raw {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}

// SplitPostingNumbers splits on comma, trims, drops empty, and keeps 200.
func SplitPostingNumbers(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
		if len(out) == MaxPostingNumbers {
			break
		}
	}
	return out
}

// RFC3339Zulu is seconds precision with a Z suffix.
func RFC3339Zulu(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

// ListWindow is now ± days.
func ListWindow(now time.Time, days int64) (from, to string) {
	return RFC3339Zulu(now.AddDate(0, 0, -int(days))), RFC3339Zulu(now.AddDate(0, 0, int(days)))
}

// UnfulfilledBody is the list request. Empty cursor, statuses, translit, and with are omitted.
func UnfulfilledBody(cursor string, from, to string, limit int64) ([]byte, error) {
	type filter struct {
		CutoffFrom string `json:"cutoff_from"`
		CutoffTo   string `json:"cutoff_to"`
	}
	body := struct {
		Cursor  string `json:"cursor,omitempty"`
		Filter  filter `json:"filter"`
		Limit   int64  `json:"limit"`
		SortDir string `json:"sort_dir"`
	}{
		Cursor:  strings.TrimSpace(cursor),
		Filter:  filter{CutoffFrom: from, CutoffTo: to},
		Limit:   limit,
		SortDir: "ASC",
	}
	return json.Marshal(body)
}

// GetV3Body is the posting detail request.
func GetV3Body(postingNumber string) ([]byte, error) {
	body := struct {
		PostingNumber string `json:"posting_number"`
		With          struct {
			AnalyticsData bool `json:"analytics_data"`
		} `json:"with"`
	}{}
	body.PostingNumber = postingNumber
	body.With.AnalyticsData = true
	return json.Marshal(body)
}

// ParseUnfulfilled reads the mock's top-level page, or a result wrapper.
func ParseUnfulfilled(raw json.RawMessage) (postings []Posting, cursor string, hasNext bool, err error) {
	body := unwrapResult(raw)
	var doc struct {
		Postings []struct {
			PostingNumber string `json:"posting_number"`
			InProcessAt   string `json:"in_process_at"`
			ShipmentDate  string `json:"shipment_date"`
			Status        string `json:"status"`
			Substatus     string `json:"substatus"`
			Products      []struct {
				SKU      int64  `json:"sku"`
				OfferID  string `json:"offer_id"`
				Name     string `json:"name"`
				Quantity int32  `json:"quantity"`
			} `json:"products"`
		} `json:"postings"`
		Cursor  string `json:"cursor"`
		HasNext bool   `json:"has_next"`
	}
	if err = json.Unmarshal(body, &doc); err != nil {
		return nil, "", false, err
	}
	for _, row := range doc.Postings {
		p := Posting{
			PostingNumber: row.PostingNumber,
			InProcessAt:   row.InProcessAt,
			ShipmentDate:  row.ShipmentDate,
			Status:        row.Status,
			Substatus:     row.Substatus,
		}
		for _, product := range row.Products {
			p.Products = append(p.Products, PostingProduct{
				SKU: product.SKU, OfferID: product.OfferID, Name: product.Name, Quantity: product.Quantity,
			})
		}
		postings = append(postings, p)
	}
	return postings, doc.Cursor, doc.HasNext, nil
}

// Purpose is delegate-asset:{binding}:{store}.
func Purpose(bindingID, storeID string) string {
	return "delegate-asset:" + bindingID + ":" + storeID
}

// NewDispatchNo is dsp_ plus a version-4 uuid without hyphens.
func NewDispatchNo() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	id, err := uuid.FromBytes(b[:])
	if err != nil {
		return "", err
	}
	return "dsp_" + strings.ReplaceAll(id.String(), "-", ""), nil
}

// QueryMissing is the axum QueryRejection sentence for a missing field.
func QueryMissing(field string) string {
	return "Failed to deserialize query string: missing field `" + field + "`"
}

// SellerReadMessage is the 502 sentence for a classified read failure.
func SellerReadMessage(operation, path string, status int, kind string) string {
	switch kind {
	case "timeout":
		return "Ozon " + operation + "超时（" + path + "）"
	case "connect":
		return "无法连接 Ozon Seller API（" + path + "）"
	case "decode":
		return "Ozon " + operation + "返回的数据无法解析（" + path + "）"
	default:
		if status > 0 {
			return "Ozon " + operation + "失败（HTTP " + strconv.Itoa(status) + "）"
		}
		return "Ozon " + operation + "失败（HTTP 0）"
	}
}

const readRateLimit = "Ozon 读取频率已达上限，请稍后重试"

// RateLimitMessage is the 429 sentence.
func RateLimitMessage() string { return readRateLimit }
