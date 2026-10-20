package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Shipping is the admin shipping preset, bind, and injection service.
type Shipping struct {
	port ShippingPort
	opt  ShippingOptions
}

// NewShipping keeps the port and the write switches. A nil Now uses time.Now.
func NewShipping(p ShippingPort, opt ShippingOptions) *Shipping {
	return &Shipping{port: p, opt: opt}
}

func (s *Shipping) now() int64 {
	if s != nil && s.opt.Now != nil {
		return s.opt.Now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

func (s *Shipping) mint(prefix string) string {
	id := ""
	if s != nil && s.opt.NewID != nil {
		id = s.opt.NewID()
	}
	id = strings.ReplaceAll(id, "-", "")
	if id == "" {
		var b [16]byte
		_, _ = rand.Read(b[:])
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		id = hex.EncodeToString(b[:])
	}
	return prefix + "_" + id
}

func (s *Shipping) actor(a domain.Actor) domain.Actor {
	if a.OrgID < 0 {
		a.OrgID = 0
	}
	return a
}

// ListPresets returns the current version of every preset.
func (s *Shipping) ListPresets(ctx context.Context) (domain.PresetListResponse, error) {
	rows, err := s.port.ListPresets(ctx)
	if err != nil {
		return domain.PresetListResponse{}, err
	}
	if rows == nil {
		rows = []domain.Preset{}
	}
	var out domain.PresetListResponse
	out.Data.Presets = rows
	return out, nil
}

// GetPreset returns the current row and every version.
func (s *Shipping) GetPreset(ctx context.Context, id string) (domain.PresetResponse, error) {
	view, err := s.port.GetPreset(ctx, id)
	if err != nil {
		return domain.PresetResponse{}, err
	}
	if view.Versions == nil {
		view.Versions = []domain.Version{}
	}
	return domain.PresetResponse{Data: view}, nil
}

// CreatePreset validates, then inserts version 1 under a writer lease.
func (s *Shipping) CreatePreset(ctx context.Context, actor domain.Actor, raw []byte) (domain.PresetResponse, error) {
	name, payload, aerr := domain.DecodeCreate(raw)
	if aerr != nil {
		return domain.PresetResponse{}, aerr
	}
	name, payload, aerr = domain.PrepareCreate(name, payload)
	if aerr != nil {
		return domain.PresetResponse{}, aerr
	}
	row, err := s.port.CreatePreset(ctx, s.actor(actor), s.mint("shp"), name, payload, s.now())
	if err != nil {
		return domain.PresetResponse{}, err
	}
	return domain.PresetResponse{Data: domain.PresetView{Preset: row, Versions: []domain.Version{}}}, nil
}

// UpdatePreset publishes expected+1.
func (s *Shipping) UpdatePreset(ctx context.Context, actor domain.Actor, id string, raw []byte) (domain.PresetResponse, error) {
	expected, name, payload, aerr := domain.DecodeUpdate(raw)
	if aerr != nil {
		return domain.PresetResponse{}, aerr
	}
	name, payload, aerr = domain.PrepareUpdate(expected, name, payload)
	if aerr != nil {
		return domain.PresetResponse{}, aerr
	}
	row, err := s.port.UpdatePreset(ctx, s.actor(actor), id, expected, name, payload, s.now())
	if err != nil {
		return domain.PresetResponse{}, err
	}
	return domain.PresetResponse{Data: domain.PresetView{Preset: row, Versions: []domain.Version{}}}, nil
}

// DeletePreset removes a preset that nothing references.
func (s *Shipping) DeletePreset(ctx context.Context, actor domain.Actor, id string) (domain.OKResponse, error) {
	if err := s.port.DeletePreset(ctx, s.actor(actor), id); err != nil {
		return domain.OKResponse{}, err
	}
	var out domain.OKResponse
	out.Data.OK = true
	return out, nil
}

// BindSKU upserts one platform SKU.
func (s *Shipping) BindSKU(ctx context.Context, actor domain.Actor, raw []byte) (domain.BindingResponse, error) {
	sku, preset, aerr := domain.DecodeBind(raw)
	if aerr != nil {
		return domain.BindingResponse{}, aerr
	}
	sku, preset, aerr = domain.NormalizeIDs(sku, preset)
	if aerr != nil {
		return domain.BindingResponse{}, aerr
	}
	row, err := s.port.Bind(ctx, s.actor(actor), sku, preset, s.now())
	if err != nil {
		return domain.BindingResponse{}, err
	}
	var out domain.BindingResponse
	out.Data.Binding = row
	return out, nil
}

// UnbindSKU deletes one bind.
func (s *Shipping) UnbindSKU(ctx context.Context, actor domain.Actor, sku string) (domain.OKResponse, error) {
	if err := s.port.Unbind(ctx, s.actor(actor), sku); err != nil {
		return domain.OKResponse{}, err
	}
	var out domain.OKResponse
	out.Data.OK = true
	return out, nil
}

// ApplyProduct binds every SKU of the product, in created_at, sku_id order.
func (s *Shipping) ApplyProduct(ctx context.Context, actor domain.Actor, preset string, raw []byte) (domain.BindingListResponse, error) {
	product, aerr := domain.DecodeApply(raw)
	if aerr != nil {
		return domain.BindingListResponse{}, aerr
	}
	product, aerr = domain.NormalizeProduct(product)
	if aerr != nil {
		return domain.BindingListResponse{}, aerr
	}
	rows, err := s.port.Apply(ctx, s.actor(actor), product, preset, s.now())
	if err != nil {
		return domain.BindingListResponse{}, err
	}
	if rows == nil {
		rows = []domain.Binding{}
	}
	var out domain.BindingListResponse
	out.Data.Bindings = rows
	return out, nil
}

// Readiness is the admin projection. It does not add writes_disabled.
func (s *Shipping) Readiness(ctx context.Context, sku, store string) (domain.ReadinessResponse, error) {
	bind, payload, inject, err := s.port.Readiness(ctx, sku, strings.TrimSpace(store))
	if err != nil {
		return domain.ReadinessResponse{}, err
	}
	var out domain.ReadinessResponse
	out.Data.Readiness = domain.EvaluateReadiness(sku, bind, strings.TrimSpace(store), payload, inject)
	if out.Data.Readiness.Reasons == nil {
		out.Data.Readiness.Reasons = []string{}
	}
	return out, nil
}

// ListInjections returns every diagnostic. canReconcile is always true.
func (s *Shipping) ListInjections(ctx context.Context) (domain.InjectionListResponse, error) {
	rows, err := s.port.ListDiagnostics(ctx)
	if err != nil {
		return domain.InjectionListResponse{}, err
	}
	now := s.now()
	outRows := make([]domain.Injection, 0, len(rows))
	for _, row := range rows {
		outRows = append(outRows, domain.InjectionView(row, now))
	}
	var out domain.InjectionListResponse
	out.Data.Injections = outRows
	return out, nil
}

// GetInjection returns one diagnostic.
func (s *Shipping) GetInjection(ctx context.Context, store, preset string) (domain.InjectionResponse, error) {
	row, err := s.port.LoadDiagnostic(ctx, store, preset)
	if err != nil {
		return domain.InjectionResponse{}, err
	}
	var out domain.InjectionResponse
	out.Data.Injection = domain.InjectionView(row, s.now())
	return out, nil
}

// Reconcile does not read the inject-writes switch or the seller write gate.
// The Ozon list call is not ported: the credential decrypt after the expiry
// check is cut off, and this process must not invent a Seller URL.
func (s *Shipping) Reconcile(ctx context.Context, store, preset string) (domain.InjectionResponse, error) {
	fact, err := s.port.LoadSafe(ctx, store, preset)
	if err != nil {
		return domain.InjectionResponse{}, err
	}
	if !fact.Found {
		return domain.InjectionResponse{}, domain.Fail(404, "NOT_FOUND", "记录不存在")
	}
	if !fact.PresetFound {
		return domain.InjectionResponse{}, domain.Fail(400, "VALIDATION", "物流预设不存在")
	}
	if !fact.VersionFound {
		return domain.InjectionResponse{}, domain.Fail(400, "VALIDATION", "物流预设版本不存在")
	}
	// unconfirmed: seller-api list response field names are sketched, but the live credential open and the loopback client are not wired here.
	return domain.InjectionResponse{}, domain.NotPorted()
}

// SafeContinue checks the inject switch before any read, then the seller write gate, then the absence proof.
// The create call itself is not ported.
func (s *Shipping) SafeContinue(ctx context.Context, store, preset string) (domain.InjectionResponse, error) {
	if err := domain.InjectWritesClosed(s.opt.InjectWrites); err != nil {
		return domain.InjectionResponse{}, err
	}
	fact, err := s.port.LoadSafe(ctx, store, preset)
	if err != nil {
		return domain.InjectionResponse{}, err
	}
	if !fact.Found {
		return domain.InjectionResponse{}, domain.Fail(404, "NOT_FOUND", "记录不存在")
	}
	if err := domain.SellerWritesClosed(s.opt.OzonWritesDisabled); err != nil {
		return domain.InjectionResponse{}, err
	}
	if !fact.PresetFound {
		return domain.InjectionResponse{}, domain.Fail(400, "VALIDATION", "物流预设不存在")
	}
	if !fact.VersionFound {
		return domain.InjectionResponse{}, domain.Fail(400, "VALIDATION", "物流预设版本不存在")
	}
	if err := domain.SafeContinueBlock(s.now(), fact); err != nil {
		return domain.InjectionResponse{}, err
	}
	// unconfirmed: map_aggregator_create's serde field names and the operation-status response shape are not fully pasted.
	return domain.InjectionResponse{}, domain.NotPorted()
}
