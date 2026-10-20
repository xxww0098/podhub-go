package contract

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"unicode/utf8"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/egressgate"
	shiprules "github.com/xxww0098/podhub-go/internal/shipping/contract"
)

// APIError is the admin wire failure.
type APIError = corecontract.APIError

// Fail builds an API error. Message is the JSON error field.
func Fail(status int, code, message string) *APIError {
	return corecontract.Fail(status, code, message)
}

// NotPorted is the envelope for a branch this port does not invent.
func NotPorted() *APIError { return corecontract.NotPorted() }

// Marshal encodes v with struct field order, no HTML escape, and no trailing newline.
func Marshal(v any) ([]byte, error) { return corecontract.Marshal(v) }

const (
	maxNameChars      = 100
	maxWarehouseChars = 100
	maxCommentChars   = 3000
	maxCourierPhones  = 3

	msgBadJSON = "请求格式无效"
)

var (
	cutInMinutes     = []int64{15, 30, 60, 120, 180, 240, 300, 360, 420, 480}
	courierCutoffs   = []int64{5, 10, 15, 20, 25, 30, 35, 40, 45}
	injectWriteBlock = Fail(httpStatusUnavailable, "WRITES_DISABLED", "物流注入写入未启用")
)

const httpStatusUnavailable = 503

// InjectMode is aggregator or non_integrated.
type InjectMode string

// WeightUnit is unpinned, g, or kg.
type WeightUnit string

// ReturnMethod is a SCREAMING_SNAKE return method.
type ReturnMethod string

// WorkingDay is a SCREAMING_SNAKE weekday.
type WorkingDay string

func (m *InjectMode) UnmarshalJSON(b []byte) error {
	return enumJSON(b, (*string)(m), "aggregator", "non_integrated")
}
func (m InjectMode) MarshalJSON() ([]byte, error) { return json.Marshal(string(m)) }

func (m *WeightUnit) UnmarshalJSON(b []byte) error {
	return enumJSON(b, (*string)(m), "unpinned", "g", "kg")
}
func (m WeightUnit) MarshalJSON() ([]byte, error) { return json.Marshal(string(m)) }

func (m *ReturnMethod) UnmarshalJSON(b []byte) error {
	return enumJSON(b, (*string)(m), "UNSPECIFIED", "COURIER", "TRANSPORT_COMPANY")
}
func (m ReturnMethod) MarshalJSON() ([]byte, error) { return json.Marshal(string(m)) }

func (m *WorkingDay) UnmarshalJSON(b []byte) error {
	return enumJSON(b, (*string)(m), "UNSPECIFIED", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY")
}
func (m WorkingDay) MarshalJSON() ([]byte, error) { return json.Marshal(string(m)) }

func enumJSON(b []byte, dst *string, allowed ...string) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	for _, a := range allowed {
		if s == a {
			*dst = s
			return nil
		}
	}
	return errors.New("enum")
}

// Coordinates is the warehouse point.
type Coordinates struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// Holiday is one closed interval.
type Holiday struct {
	Day  string `json:"day"`
	From string `json:"from"`
	To   string `json:"to"`
}

// WorkingHours is one open interval.
type WorkingHours struct {
	Day  WorkingDay `json:"day"`
	From string     `json:"from"`
	To   string     `json:"to"`
}

// Timetable is the warehouse calendar. Empty slices serialize as [].
type Timetable struct {
	Holidays    []Holiday      `json:"holidays"`
	WorkingDays []WorkingHours `json:"workingDays"`
}

// DeliveryCosts is the optional weight and price band.
type DeliveryCosts struct {
	MinWeight     *int64 `json:"minWeight,omitempty"`
	MaxWeight     *int64 `json:"maxWeight,omitempty"`
	MinOrderPrice *int64 `json:"minOrderPrice,omitempty"`
	MaxOrderPrice *int64 `json:"maxOrderPrice,omitempty"`
	SellerPayment *int64 `json:"sellerPayment,omitempty"`
}

// ReturnSettings is the optional return block.
type ReturnSettings struct {
	ContactDays          *int32        `json:"contactDays,omitempty"`
	PostOfficeZipcode    *string       `json:"postOfficeZipcode,omitempty"`
	ReturnMethod         *ReturnMethod `json:"returnMethod,omitempty"`
	TransportCompanyName *string       `json:"transportCompanyName,omitempty"`
}

// PresetPayload is one immutable preset version.
type PresetPayload struct {
	Mode               InjectMode      `json:"mode"`
	WarehouseName      string          `json:"warehouseName"`
	Phone              string          `json:"phone"`
	AddressCoordinates Coordinates     `json:"addressCoordinates"`
	Timetable          Timetable       `json:"timetableWarehouse"`
	MinOrderValue      *int64          `json:"minOrderValue,omitempty"`
	IsAutoAssembly     *bool           `json:"isAutoAssembly,omitempty"`
	DeliveryMethodName *string         `json:"deliveryMethodName,omitempty"`
	CutIn              int64           `json:"cutIn"`
	CourierCutoff      *int64          `json:"courierCutoff,omitempty"`
	CourierComment     *string         `json:"courierComment,omitempty"`
	CourierPhones      []string        `json:"courierPhones"`
	DeliverToPVZ       *bool           `json:"deliverToPvz,omitempty"`
	DeliveryCosts      *DeliveryCosts  `json:"deliveryCosts,omitempty"`
	ReturnSettings     *ReturnSettings `json:"returnSettings,omitempty"`
	WeightUnit         WeightUnit      `json:"weightUnit"`
}

type payloadWire struct {
	Mode               *InjectMode     `json:"mode"`
	WarehouseName      *string         `json:"warehouseName"`
	Phone              *string         `json:"phone"`
	AddressCoordinates *Coordinates    `json:"addressCoordinates"`
	Timetable          *Timetable      `json:"timetableWarehouse"`
	MinOrderValue      *int64          `json:"minOrderValue"`
	IsAutoAssembly     *bool           `json:"isAutoAssembly"`
	DeliveryMethodName *string         `json:"deliveryMethodName"`
	CutIn              *int64          `json:"cutIn"`
	CourierCutoff      *int64          `json:"courierCutoff"`
	CourierComment     *string         `json:"courierComment"`
	CourierPhones      []string        `json:"courierPhones"`
	DeliverToPVZ       *bool           `json:"deliverToPvz"`
	DeliveryCosts      *DeliveryCosts  `json:"deliveryCosts"`
	ReturnSettings     *ReturnSettings `json:"returnSettings"`
	WeightUnit         *WeightUnit     `json:"weightUnit"`
}

func (w payloadWire) payload() PresetPayload {
	p := PresetPayload{
		MinOrderValue:      w.MinOrderValue,
		IsAutoAssembly:     w.IsAutoAssembly,
		DeliveryMethodName: w.DeliveryMethodName,
		CourierCutoff:      w.CourierCutoff,
		CourierComment:     w.CourierComment,
		CourierPhones:      w.CourierPhones,
		DeliverToPVZ:       w.DeliverToPVZ,
		DeliveryCosts:      w.DeliveryCosts,
		ReturnSettings:     w.ReturnSettings,
	}
	if w.Mode != nil {
		p.Mode = *w.Mode
	}
	if w.WarehouseName != nil {
		p.WarehouseName = *w.WarehouseName
	}
	if w.Phone != nil {
		p.Phone = *w.Phone
	}
	if w.AddressCoordinates != nil {
		p.AddressCoordinates = *w.AddressCoordinates
	}
	if w.Timetable != nil {
		p.Timetable = *w.Timetable
	}
	if w.CutIn != nil {
		p.CutIn = *w.CutIn
	}
	if w.WeightUnit != nil {
		p.WeightUnit = *w.WeightUnit
	}
	p.fill()
	return p
}

func (p *PresetPayload) fill() {
	if p.Timetable.Holidays == nil {
		p.Timetable.Holidays = []Holiday{}
	}
	if p.Timetable.WorkingDays == nil {
		p.Timetable.WorkingDays = []WorkingHours{}
	}
	if p.CourierPhones == nil {
		p.CourierPhones = []string{}
	}
}

func badJSON() *APIError { return Fail(400, "VALIDATION", msgBadJSON) }

func decodeStrict(raw []byte, dst any) *APIError {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return badJSON()
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return badJSON()
	}
	return nil
}

// DecodeCreate parses a create body. Unknown fields are 请求格式无效.
func DecodeCreate(raw []byte) (string, PresetPayload, *APIError) {
	var body struct {
		Name    *string      `json:"name"`
		Payload *payloadWire `json:"payload"`
	}
	if err := decodeStrict(raw, &body); err != nil {
		return "", PresetPayload{}, err
	}
	if body.Name == nil || body.Payload == nil || !wireComplete(*body.Payload) {
		return "", PresetPayload{}, badJSON()
	}
	return *body.Name, body.Payload.payload(), nil
}

// DecodeUpdate parses a publish body.
func DecodeUpdate(raw []byte) (int64, string, PresetPayload, *APIError) {
	var body struct {
		Expected *int64       `json:"expectedCurrentVersion"`
		Name     *string      `json:"name"`
		Payload  *payloadWire `json:"payload"`
	}
	if err := decodeStrict(raw, &body); err != nil {
		return 0, "", PresetPayload{}, err
	}
	if body.Expected == nil || body.Name == nil || body.Payload == nil || !wireComplete(*body.Payload) {
		return 0, "", PresetPayload{}, badJSON()
	}
	return *body.Expected, *body.Name, body.Payload.payload(), nil
}

func wireComplete(w payloadWire) bool {
	return w.Mode != nil && w.WarehouseName != nil && w.Phone != nil && w.AddressCoordinates != nil && w.CutIn != nil && w.WeightUnit != nil
}

// DecodeBind parses skuId and presetId.
func DecodeBind(raw []byte) (string, string, *APIError) {
	var body struct {
		SKUID    *string `json:"skuId"`
		PresetID *string `json:"presetId"`
	}
	if err := decodeStrict(raw, &body); err != nil {
		return "", "", err
	}
	if body.SKUID == nil || body.PresetID == nil {
		return "", "", badJSON()
	}
	return *body.SKUID, *body.PresetID, nil
}

// DecodeApply parses productId.
func DecodeApply(raw []byte) (string, *APIError) {
	var body struct {
		ProductID *string `json:"productId"`
	}
	if err := decodeStrict(raw, &body); err != nil {
		return "", err
	}
	if body.ProductID == nil {
		return "", badJSON()
	}
	return *body.ProductID, nil
}

// PrepareCreate validates a new preset.
func PrepareCreate(name string, payload PresetPayload) (string, PresetPayload, *APIError) {
	name, err := requiredText(name, "预设名称", maxNameChars)
	if err != nil {
		return "", PresetPayload{}, err
	}
	payload, err = NormalizePayload(payload)
	if err != nil {
		return "", PresetPayload{}, err
	}
	return name, payload, nil
}

// PrepareUpdate validates a publish. expected < 1 is rejected before the payload.
func PrepareUpdate(expected int64, name string, payload PresetPayload) (string, PresetPayload, *APIError) {
	if expected < 1 {
		return "", PresetPayload{}, Fail(400, "VALIDATION", "expectedCurrentVersion 无效")
	}
	return PrepareCreate(name, payload)
}

// NormalizeIDs trims a bind pair.
func NormalizeIDs(sku, preset string) (string, string, *APIError) {
	sku = strings.TrimSpace(sku)
	preset = strings.TrimSpace(preset)
	if sku == "" || preset == "" {
		return "", "", Fail(400, "VALIDATION", "请选择平台 SKU 和物流预设")
	}
	return sku, preset, nil
}

// NormalizeProduct trims a product id.
func NormalizeProduct(product string) (string, *APIError) {
	product = strings.TrimSpace(product)
	if product == "" {
		return "", Fail(400, "VALIDATION", "请选择平台商品")
	}
	return product, nil
}

// NormalizePayload is the preset checker. Messages are the Rust sentences.
func NormalizePayload(payload PresetPayload) (PresetPayload, *APIError) {
	payload.fill()
	name, err := requiredText(payload.WarehouseName, "仓库名称", maxWarehouseChars)
	if err != nil {
		return PresetPayload{}, err
	}
	payload.WarehouseName = name
	phone, err := ruPhone(payload.Phone, "仓库电话")
	if err != nil {
		return PresetPayload{}, err
	}
	payload.Phone = phone
	if err := validateCoordinates(payload.AddressCoordinates); err != nil {
		return PresetPayload{}, err
	}
	if !containsInt(cutInMinutes, payload.CutIn) {
		return PresetPayload{}, Fail(400, "VALIDATION", "cutIn 不是官方分钟枚举")
	}
	if payload.CourierCutoff != nil && !containsInt(courierCutoffs, *payload.CourierCutoff) {
		return PresetPayload{}, Fail(400, "VALIDATION", "courierCutoff 不是官方分钟枚举")
	}
	if payload.Mode == "non_integrated" && payload.CourierCutoff == nil {
		return PresetPayload{}, Fail(400, "VALIDATION", "非聚合模式必须填写 courierCutoff")
	}
	if payload.DeliveryMethodName != nil {
		n, err := requiredText(*payload.DeliveryMethodName, "配送方式名称", maxWarehouseChars)
		if err != nil {
			return PresetPayload{}, err
		}
		payload.DeliveryMethodName = &n
	}
	if payload.CourierComment != nil {
		n, err := boundedText(*payload.CourierComment, "快递员备注", maxCommentChars)
		if err != nil {
			return PresetPayload{}, err
		}
		payload.CourierComment = &n
	}
	if len(payload.CourierPhones) > maxCourierPhones {
		return PresetPayload{}, Fail(400, "VALIDATION", "快递员电话最多 3 个")
	}
	phones := make([]string, 0, len(payload.CourierPhones))
	for _, phone := range payload.CourierPhones {
		n, err := ruPhone(phone, "快递员电话")
		if err != nil {
			return PresetPayload{}, err
		}
		phones = append(phones, n)
	}
	payload.CourierPhones = phones
	v, err := nonNegative(payload.MinOrderValue, "最低订单额")
	if err != nil {
		return PresetPayload{}, err
	}
	payload.MinOrderValue = v
	if payload.DeliveryCosts != nil {
		costs, err := normalizeCosts(*payload.DeliveryCosts)
		if err != nil {
			return PresetPayload{}, err
		}
		payload.DeliveryCosts = &costs
	}
	if err := rejectUnpinned(payload); err != nil {
		return PresetPayload{}, err
	}
	if err := rejectKgOverflow(payload); err != nil {
		return PresetPayload{}, err
	}
	if payload.ReturnSettings != nil {
		settings, err := normalizeReturn(*payload.ReturnSettings)
		if err != nil {
			return PresetPayload{}, err
		}
		payload.ReturnSettings = &settings
	}
	payload.fill()
	return payload, nil
}

func requiredText(value, label string, max int) (string, *APIError) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > max {
		return "", Fail(400, "VALIDATION", label+"需为 1–"+itoa(max)+" 个字符")
	}
	return trimmed, nil
}

func boundedText(value, label string, max int) (string, *APIError) {
	trimmed := strings.TrimSpace(value)
	if utf8.RuneCountInString(trimmed) > max {
		return "", Fail(400, "VALIDATION", label+"不能超过 "+itoa(max)+" 个字符")
	}
	return trimmed, nil
}

func ruPhone(value, label string) (string, *APIError) {
	trimmed := strings.TrimSpace(value)
	if !isRuPhone(trimmed) {
		return "", Fail(400, "VALIDATION", label+"须为 +7(XXX)XXX-XX-XX")
	}
	return trimmed, nil
}

func isRuPhone(value string) bool {
	if len(value) != 16 || !strings.HasPrefix(value, "+7(") {
		return false
	}
	b := value
	if b[6] != ')' || b[10] != '-' || b[13] != '-' {
		return false
	}
	return digits(b[3:6]) && digits(b[7:10]) && digits(b[11:13]) && digits(b[14:16])
}

func digits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func nonNegative(value *int64, label string) (*int64, *APIError) {
	if value != nil && *value < 0 {
		return nil, Fail(400, "VALIDATION", label+"不能为负数")
	}
	return value, nil
}

func validateCoordinates(c Coordinates) *APIError {
	if c.Latitude < -90 || c.Latitude > 90 || c.Longitude < -180 || c.Longitude > 180 {
		return Fail(400, "VALIDATION", "仓库坐标无效")
	}
	if math.IsNaN(c.Latitude) || math.IsNaN(c.Longitude) {
		return Fail(400, "VALIDATION", "仓库坐标无效")
	}
	return nil
}

func normalizeCosts(c DeliveryCosts) (DeliveryCosts, *APIError) {
	var err *APIError
	if c.MinWeight, err = nonNegative(c.MinWeight, "最低重量"); err != nil {
		return DeliveryCosts{}, err
	}
	if c.MaxWeight, err = nonNegative(c.MaxWeight, "最高重量"); err != nil {
		return DeliveryCosts{}, err
	}
	if c.MinOrderPrice, err = nonNegative(c.MinOrderPrice, "最低订单价"); err != nil {
		return DeliveryCosts{}, err
	}
	if c.MaxOrderPrice, err = nonNegative(c.MaxOrderPrice, "最高订单价"); err != nil {
		return DeliveryCosts{}, err
	}
	if c.SellerPayment, err = nonNegative(c.SellerPayment, "卖家配送费"); err != nil {
		return DeliveryCosts{}, err
	}
	return c, nil
}

func rejectUnpinned(p PresetPayload) *APIError {
	if p.WeightUnit == "unpinned" && costWeights(p) {
		return Fail(400, "VALIDATION", "未钉定重量单位时不能填写重量区间，请使用 g")
	}
	return nil
}

func costWeights(p PresetPayload) bool {
	return p.DeliveryCosts != nil && (p.DeliveryCosts.MinWeight != nil || p.DeliveryCosts.MaxWeight != nil)
}

func rejectKgOverflow(p PresetPayload) *APIError {
	if p.WeightUnit != "kg" || p.DeliveryCosts == nil {
		return nil
	}
	for _, pair := range []struct {
		label string
		value *int64
	}{{"最低重量", p.DeliveryCosts.MinWeight}, {"最高重量", p.DeliveryCosts.MaxWeight}} {
		if pair.value != nil && *pair.value > math.MaxInt64/1000 {
			return Fail(400, "VALIDATION", pair.label+"按千克换算克会溢出")
		}
	}
	return nil
}

func normalizeReturn(s ReturnSettings) (ReturnSettings, *APIError) {
	if s.ContactDays != nil && *s.ContactDays < 0 {
		return ReturnSettings{}, Fail(400, "VALIDATION", "退货联系天数不能为负数")
	}
	s.PostOfficeZipcode = trimEmpty(s.PostOfficeZipcode)
	s.TransportCompanyName = trimEmpty(s.TransportCompanyName)
	return s, nil
}

func trimEmpty(v *string) *string {
	if v == nil {
		return nil
	}
	t := strings.TrimSpace(*v)
	if t == "" {
		return nil
	}
	return &t
}

func containsInt(set []int64, v int64) bool {
	for _, n := range set {
		if n == v {
			return true
		}
	}
	return false
}

// DecodeStoredPayload returns the fallback preset when the row JSON is not the wire shape.
func DecodeStoredPayload(raw []byte) PresetPayload {
	var w payloadWire
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&w); err != nil || !wireComplete(w) {
		return FallbackPayload()
	}
	return w.payload()
}

// FallbackPayload is the hard-coded row used when version JSON will not decode.
func FallbackPayload() PresetPayload {
	p := PresetPayload{
		Mode:          "aggregator",
		WarehouseName: "",
		Phone:         "+7(000)000-00-00",
		CutIn:         15,
		WeightUnit:    "g",
	}
	p.fill()
	return p
}

// InjectWritesClosed is switch A. Reconcile does not call it.
func InjectWritesClosed(enabled bool) *APIError {
	if enabled {
		return nil
	}
	return injectWriteBlock
}

// SellerWritesClosed is switch B. The message is the egress sentinel's Error text.
func SellerWritesClosed(disabled bool) *APIError {
	if !disabled {
		return nil
	}
	err := egressgate.ErrWritesDisabled
	if errors.Is(err, egressgate.ErrWritesDisabled) {
		return Fail(503, "WRITES_DISABLED", err.Error())
	}
	return Fail(503, "WRITES_DISABLED", err.Error())
}

// Transition is one named injection edge. Illegal edges return false.
func Transition(from, edge string) (string, bool) {
	switch edge {
	case "reconcile_list_failed", "reconcile_absent":
		if knownStatus(from) {
			return "unknown", true
		}
	case "reconcile_active":
		if knownStatus(from) {
			return "succeeded", true
		}
	case "reconcile_method_waiting", "reconcile_no_method":
		if knownStatus(from) {
			return "waiting", true
		}
	case "safe_continue":
		if from == "unknown" {
			return "submitting", true
		}
	case "create_accepted":
		if from == "submitting" {
			return "waiting", true
		}
	case "create_lost":
		if from == "submitting" {
			return "unknown", true
		}
	case "create_failed":
		if from == "submitting" {
			return "failed", true
		}
	}
	return "", false
}

func knownStatus(s string) bool {
	switch s {
	case "queued", "submitting", "waiting", "succeeded", "failed", "unknown":
		return true
	default:
		return false
	}
}

// Inflight is queued, submitting, or waiting.
func Inflight(status string) bool { return shiprules.Inflight(status) }

// SafeFact is the row admin_safe_continue reads before create.
type SafeFact struct {
	Found            bool
	PresetFound      bool
	VersionFound     bool
	Mode             string
	Status           string
	WarehouseID      *int64
	RemoteAbsentAtMs *int64
}

const absenceFreshMS = shiprules.AbsenceFreshMS

// SafeContinueBlock is the 400 gate in front of create. Nil means create may start.
func SafeContinueBlock(now int64, f SafeFact) *APIError {
	if f.Mode == "non_integrated" {
		return Fail(400, "VALIDATION", "非聚合模式不支持一键注入")
	}
	if !f.Found {
		return Fail(400, "VALIDATION", "没有注入事实")
	}
	if msg := shiprules.ProofMessage(f.Status, f.RemoteAbsentAtMs, f.WarehouseID, now); msg != "" {
		return Fail(400, "VALIDATION", msg)
	}
	return nil
}

// ListedMethod is one delivery method row from a list call.
type ListedMethod struct {
	ID          int64
	WarehouseID int64
	Name        string
	Status      string
	IsExpress   bool
}

// PickMethod prefers the known id, then the express method of this warehouse.
func PickMethod(wanted *string, warehouseID int64, known *int64, methods []ListedMethod) *ListedMethod {
	listed := make([]shiprules.Method, len(methods))
	for i := range methods {
		listed[i] = shiprules.Method{
			ID: methods[i].ID, WarehouseID: methods[i].WarehouseID,
			Name: methods[i].Name, Express: methods[i].IsExpress,
		}
	}
	i := shiprules.PickListed(wanted, warehouseID, known, listed)
	if i < 0 {
		return nil
	}
	return &methods[i]
}

// VerifyOutcome is the status verify_ids would persist. fallback is waiting for reconcile.
func VerifyOutcome(chosen *ListedMethod, fallback string) (status string, id *int64, methodStatus *string) {
	if chosen == nil {
		return fallback, nil, nil
	}
	id = &chosen.ID
	st := chosen.Status
	methodStatus = &st
	if strings.EqualFold(chosen.Status, "ACTIVE") {
		return "succeeded", id, methodStatus
	}
	return "waiting", id, methodStatus
}

// BindingRef is the admin readiness bind.
type BindingRef struct {
	PresetID        string
	RequiredVersion int64
}

// InjectionFact is the shop injection row readiness reads.
type InjectionFact struct {
	PinnedVersion        int64
	Status               string
	WarehouseID          *int64
	DeliveryMethodID     *int64
	DeliveryMethodStatus *string
}

// Readiness is the admin GET body object.
type Readiness struct {
	SKUID            string   `json:"skuId"`
	PresetID         *string  `json:"presetId,omitempty"`
	RequiredVersion  *int64   `json:"requiredVersion,omitempty"`
	PinnedVersion    *int64   `json:"pinnedVersion,omitempty"`
	Status           string   `json:"status"`
	InjectReady      bool     `json:"injectReady"`
	Reasons          []string `json:"reasons"`
	WarehouseID      *int64   `json:"warehouseId,omitempty"`
	DeliveryMethodID *int64   `json:"deliveryMethodId,omitempty"`
	InjectStatus     *string  `json:"injectStatus,omitempty"`
}

// ReadinessResponse is the HTTP envelope.
type ReadinessResponse struct {
	Data struct {
		Readiness Readiness `json:"readiness"`
	} `json:"data"`
}

// EvaluateReadiness applies the admin readiness rules. storeUUID empty means the query omitted it.
func EvaluateReadiness(sku string, bind *BindingRef, storeUUID string, payload *PresetPayload, inject *InjectionFact) Readiness {
	if bind == nil {
		return Readiness{SKUID: sku, Status: "blocked", Reasons: []string{"missing_bind"}}
	}
	if strings.TrimSpace(storeUUID) == "" {
		req := bind.RequiredVersion
		id := bind.PresetID
		return Readiness{
			SKUID:           sku,
			PresetID:        &id,
			RequiredVersion: &req,
			Status:          "blocked",
			Reasons:         []string{"inject_not_available"},
		}
	}
	var reasons []string
	if payload != nil {
		if payload.Mode == "non_integrated" {
			reasons = append(reasons, "non_integrated_unsupported")
		}
		if payload.WeightUnit == "unpinned" && costWeights(*payload) {
			reasons = append(reasons, "weight_unit_unpinned")
		}
	}
	id := bind.PresetID
	req := bind.RequiredVersion
	if inject == nil {
		reasons = append(reasons, "shop_not_injected")
		return Readiness{
			SKUID: sku, PresetID: &id, RequiredVersion: &req,
			Status: "blocked", Reasons: reasons,
		}
	}
	status := parseStatus(inject.Status)
	switch status {
	case "waiting", "queued", "submitting":
		reasons = append(reasons, "waiting")
	case "unknown":
		reasons = append(reasons, "result_unknown")
	case "failed":
		reasons = append(reasons, "failed")
	case "succeeded":
		if inject.PinnedVersion != bind.RequiredVersion {
			reasons = append(reasons, "stale_version")
		}
		active := inject.DeliveryMethodStatus != nil && strings.EqualFold(*inject.DeliveryMethodStatus, "ACTIVE")
		if !active {
			reasons = append(reasons, "delivery_method_not_active")
		}
		if inject.WarehouseID == nil || inject.DeliveryMethodID == nil {
			reasons = append(reasons, "shop_not_injected")
		}
	}
	outStatus := "blocked"
	if len(reasons) == 0 && status == "succeeded" {
		outStatus = "ready"
	} else if has(reasons, "stale_version") && !has(reasons, "waiting") && !has(reasons, "result_unknown") && !has(reasons, "failed") {
		outStatus = "stale"
	}
	pinned := inject.PinnedVersion
	st := status
	if reasons == nil {
		reasons = []string{}
	}
	return Readiness{
		SKUID: sku, PresetID: &id, RequiredVersion: &req, PinnedVersion: &pinned,
		Status: outStatus, InjectReady: outStatus == "ready", Reasons: reasons,
		WarehouseID: inject.WarehouseID, DeliveryMethodID: inject.DeliveryMethodID, InjectStatus: &st,
	}
}

func parseStatus(v string) string {
	switch v {
	case "queued", "submitting", "waiting", "succeeded", "failed":
		return v
	default:
		return "unknown"
	}
}

func has(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// Diagnostic is one shipping_shop_injections projection.
type Diagnostic struct {
	StoreUUID           string
	PresetID            string
	PresetName          string
	DesiredVersion      int64
	PinnedVersion       int64
	Status              string
	WarehouseID         *int64
	DeliveryMethodID    *int64
	LastOzonOperationID *string
	RemoteAbsentAtMs    *int64
	Phase               *string
	RequestFingerprint  *string
	LastPolledAtMs      *int64
	WaitingSinceMs      *int64
}

// Injection is the admin diagnostic object.
type Injection struct {
	StoreUUID          string  `json:"storeUuid"`
	PresetID           string  `json:"presetId"`
	PresetName         string  `json:"presetName"`
	DesiredVersion     int64   `json:"desiredVersion"`
	AppliedVersion     int64   `json:"appliedVersion"`
	WarehouseID        *int64  `json:"warehouseId,omitempty"`
	DeliveryMethodID   *int64  `json:"deliveryMethodId,omitempty"`
	InjectStatus       string  `json:"injectStatus"`
	Phase              *string `json:"phase,omitempty"`
	OzonOperationID    *string `json:"ozonOperationId,omitempty"`
	WaitingDurationMs  *int64  `json:"waitingDurationMs,omitempty"`
	RequestFingerprint *string `json:"requestFingerprint,omitempty"`
	LastPolledAtMs     *int64  `json:"lastPolledAtMs,omitempty"`
	SafeError          *string `json:"safeError,omitempty"`
	CanReconcile       bool    `json:"canReconcile"`
	CanSafeContinue    bool    `json:"canSafeContinue"`
}

// InjectionView maps one diagnostic row.
func InjectionView(row Diagnostic, now int64) Injection {
	out := Injection{
		StoreUUID: row.StoreUUID, PresetID: row.PresetID, PresetName: row.PresetName,
		DesiredVersion: row.DesiredVersion, AppliedVersion: row.PinnedVersion,
		WarehouseID: row.WarehouseID, DeliveryMethodID: row.DeliveryMethodID,
		InjectStatus: parseStatus(row.Status), Phase: row.Phase, OzonOperationID: row.LastOzonOperationID,
		RequestFingerprint: row.RequestFingerprint, LastPolledAtMs: row.LastPolledAtMs,
		CanReconcile:    true,
		CanSafeContinue: shiprules.CanSafeContinue(row.Status, row.RemoteAbsentAtMs, row.WarehouseID),
	}
	if row.WaitingSinceMs != nil {
		d := now - *row.WaitingSinceMs
		if d < 0 {
			d = 0
		}
		out.WaitingDurationMs = &d
	}
	out.SafeError = safeError(row.Status, row.RemoteAbsentAtMs)
	return out
}

func safeError(status string, absent *int64) *string {
	s := shiprules.SafeError(status, absent)
	if s == "" {
		return nil
	}
	return &s
}

// Preset is one current preset row. RequiredVersion equals CurrentVersion.
type Preset struct {
	PresetID        string        `json:"presetId"`
	Name            string        `json:"name"`
	CurrentVersion  int64         `json:"currentVersion"`
	RequiredVersion int64         `json:"requiredVersion"`
	Payload         PresetPayload `json:"payload"`
	CreatedAtMs     int64         `json:"createdAtMs"`
	UpdatedAtMs     int64         `json:"updatedAtMs"`
}

// Version is one historical payload.
type Version struct {
	Version     int64         `json:"version"`
	Payload     PresetPayload `json:"payload"`
	CreatedAtMs int64         `json:"createdAtMs"`
}

// PresetView is the single-preset envelope. Create and publish leave Versions empty.
type PresetView struct {
	Preset   Preset    `json:"preset"`
	Versions []Version `json:"versions"`
}

// PresetResponse wraps one preset.
type PresetResponse struct {
	Data PresetView `json:"data"`
}

// PresetListResponse wraps the list.
type PresetListResponse struct {
	Data struct {
		Presets []Preset `json:"presets"`
	} `json:"data"`
}

// Binding is one SKU bind row.
type Binding struct {
	SKUID           string `json:"skuId"`
	ProductID       string `json:"productId"`
	PresetID        string `json:"presetId"`
	PresetName      string `json:"presetName"`
	RequiredVersion int64  `json:"requiredVersion"`
	CreatedAtMs     int64  `json:"createdAtMs"`
	UpdatedAtMs     int64  `json:"updatedAtMs"`
}

// BindingResponse wraps one bind.
type BindingResponse struct {
	Data struct {
		Binding Binding `json:"binding"`
	} `json:"data"`
}

// BindingListResponse wraps apply-product.
type BindingListResponse struct {
	Data struct {
		Bindings []Binding `json:"bindings"`
	} `json:"data"`
}

// OKResponse is delete/unbind.
type OKResponse struct {
	Data struct {
		OK bool `json:"ok"`
	} `json:"data"`
}

// InjectionResponse wraps one diagnostic.
type InjectionResponse struct {
	Data struct {
		Injection Injection `json:"injection"`
	} `json:"data"`
}

// InjectionListResponse wraps the list.
type InjectionListResponse struct {
	Data struct {
		Injections []Injection `json:"injections"`
	} `json:"data"`
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// NewPreset fills RequiredVersion from the current version.
func NewPreset(id, name string, version, created, updated int64, payload PresetPayload) Preset {
	payload.fill()
	return Preset{
		PresetID: id, Name: name, CurrentVersion: version, RequiredVersion: version,
		Payload: payload, CreatedAtMs: created, UpdatedAtMs: updated,
	}
}
