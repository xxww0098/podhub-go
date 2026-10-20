package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// ShippingPort is the shipping persistence seam. The repo implements it.
type ShippingPort interface {
	ListPresets(ctx context.Context) ([]domain.Preset, error)
	GetPreset(ctx context.Context, id string) (domain.PresetView, error)
	CreatePreset(ctx context.Context, actor domain.Actor, id, name string, payload domain.PresetPayload, now int64) (domain.Preset, error)
	UpdatePreset(ctx context.Context, actor domain.Actor, id string, expected int64, name string, payload domain.PresetPayload, now int64) (domain.Preset, error)
	DeletePreset(ctx context.Context, actor domain.Actor, id string) error
	Bind(ctx context.Context, actor domain.Actor, sku, preset string, now int64) (domain.Binding, error)
	Unbind(ctx context.Context, actor domain.Actor, sku string) error
	Apply(ctx context.Context, actor domain.Actor, product, preset string, now int64) ([]domain.Binding, error)
	Readiness(ctx context.Context, sku, store string) (*domain.BindingRef, *domain.PresetPayload, *domain.InjectionFact, error)
	ListDiagnostics(ctx context.Context) ([]domain.Diagnostic, error)
	LoadDiagnostic(ctx context.Context, store, preset string) (domain.Diagnostic, error)
	LoadSafe(ctx context.Context, store, preset string) (domain.SafeFact, error)
}

// ShippingOptions is the clock, id source, and the two write switches.
type ShippingOptions struct {
	Now                func() time.Time
	NewID              func() string
	OzonWritesDisabled bool
	InjectWrites       bool
}
