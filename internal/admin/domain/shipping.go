package domain

import shipcontract "github.com/xxww0098/podhub-go/internal/admin/shipping/contract"

// Shipping row types and rules live in admin/shipping/contract.
type (
	InjectMode            = shipcontract.InjectMode
	WeightUnit            = shipcontract.WeightUnit
	ReturnMethod          = shipcontract.ReturnMethod
	WorkingDay            = shipcontract.WorkingDay
	Coordinates           = shipcontract.Coordinates
	Holiday               = shipcontract.Holiday
	WorkingHours          = shipcontract.WorkingHours
	Timetable             = shipcontract.Timetable
	DeliveryCosts         = shipcontract.DeliveryCosts
	ReturnSettings        = shipcontract.ReturnSettings
	PresetPayload         = shipcontract.PresetPayload
	SafeFact              = shipcontract.SafeFact
	ListedMethod          = shipcontract.ListedMethod
	BindingRef            = shipcontract.BindingRef
	InjectionFact         = shipcontract.InjectionFact
	Readiness             = shipcontract.Readiness
	ReadinessResponse     = shipcontract.ReadinessResponse
	Diagnostic            = shipcontract.Diagnostic
	Injection             = shipcontract.Injection
	Preset                = shipcontract.Preset
	Version               = shipcontract.Version
	PresetView            = shipcontract.PresetView
	PresetResponse        = shipcontract.PresetResponse
	PresetListResponse    = shipcontract.PresetListResponse
	Binding               = shipcontract.Binding
	BindingResponse       = shipcontract.BindingResponse
	BindingListResponse   = shipcontract.BindingListResponse
	OKResponse            = shipcontract.OKResponse
	InjectionResponse     = shipcontract.InjectionResponse
	InjectionListResponse = shipcontract.InjectionListResponse
)

func DecodeCreate(raw []byte) (string, PresetPayload, *APIError) {
	return shipcontract.DecodeCreate(raw)
}
func DecodeUpdate(raw []byte) (int64, string, PresetPayload, *APIError) {
	return shipcontract.DecodeUpdate(raw)
}
func DecodeBind(raw []byte) (string, string, *APIError) { return shipcontract.DecodeBind(raw) }
func DecodeApply(raw []byte) (string, *APIError)        { return shipcontract.DecodeApply(raw) }
func PrepareCreate(name string, payload PresetPayload) (string, PresetPayload, *APIError) {
	return shipcontract.PrepareCreate(name, payload)
}
func PrepareUpdate(expected int64, name string, payload PresetPayload) (string, PresetPayload, *APIError) {
	return shipcontract.PrepareUpdate(expected, name, payload)
}
func NormalizeIDs(sku, preset string) (string, string, *APIError) {
	return shipcontract.NormalizeIDs(sku, preset)
}
func NormalizeProduct(product string) (string, *APIError) {
	return shipcontract.NormalizeProduct(product)
}
func DecodeStoredPayload(raw []byte) PresetPayload { return shipcontract.DecodeStoredPayload(raw) }
func FallbackPayload() PresetPayload               { return shipcontract.FallbackPayload() }
func InjectWritesClosed(enabled bool) *APIError    { return shipcontract.InjectWritesClosed(enabled) }
func SellerWritesClosed(disabled bool) *APIError   { return shipcontract.SellerWritesClosed(disabled) }
func SafeContinueBlock(now int64, f SafeFact) *APIError {
	return shipcontract.SafeContinueBlock(now, f)
}
func EvaluateReadiness(sku string, bind *BindingRef, storeUUID string, payload *PresetPayload, inject *InjectionFact) Readiness {
	return shipcontract.EvaluateReadiness(sku, bind, storeUUID, payload, inject)
}
func InjectionView(row Diagnostic, now int64) Injection { return shipcontract.InjectionView(row, now) }
func NewPreset(id, name string, version, created, updated int64, payload PresetPayload) Preset {
	return shipcontract.NewPreset(id, name, version, created, updated, payload)
}
