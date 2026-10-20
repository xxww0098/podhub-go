package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// CatalogPort is the catalog persistence seam.
type CatalogPort interface {
	Bases(ctx context.Context) ([]string, error)
	List(ctx context.Context) ([]domain.Product, []domain.SKU, error)
	CreateProduct(ctx context.Context, actor domain.Actor, id string, in domain.ProductInput, now int64) (domain.Product, error)
	UpdateProduct(ctx context.Context, actor domain.Actor, id string, in domain.ProductInput, now int64) (domain.Product, error)
	SetProductPublished(ctx context.Context, actor domain.Actor, id string, rev int64, published bool, now int64) (domain.Product, error)
	CreateSKU(ctx context.Context, actor domain.Actor, id string, in domain.SKUInput, now int64) (domain.SKU, error)
	UpdateSKU(ctx context.Context, actor domain.Actor, id string, in domain.SKUInput, now int64) (domain.SKU, error)
	SetPrice(ctx context.Context, actor domain.Actor, id string, rev, cents, now int64) (domain.SKU, error)
	SetSKUPublished(ctx context.Context, actor domain.Actor, id string, rev int64, published bool, now int64) (domain.SKU, error)
	ImageTarget(ctx context.Context, kind, id string) (domain.ImageTarget, error)
	AttachMedia(ctx context.Context, actor domain.Actor, kind, id string, rev int64, media []string, now int64) (domain.Product, domain.SKU, error)
}

// MediaAccount is one decrypted media bucket. Endpoint must be loopback before any dial.
type MediaAccount struct {
	PublicBaseURL   string
	Endpoint        string
	Region          string
	Bucket          string
	Prefix          string
	AccessKeyID     string
	SecretAccessKey string
	Persistent      bool
	Slice           bool
	Staging         bool
	Active          bool
}

// BlobPort reads and writes object bytes. Implementations refuse non-loopback endpoints.
type BlobPort interface {
	Get(ctx context.Context, account MediaAccount, key string) (body []byte, contentType string, status int, err error)
	Put(ctx context.Context, account MediaAccount, key string, body []byte, contentType string) (status int, err error)
}

// CatalogOptions supplies the clock, ids, and optional media accounts.
// A nil Media slice means the platform has no media configuration.
type CatalogOptions struct {
	Now   func() time.Time
	NewID func() string
	Media []MediaAccount
	Blobs BlobPort
	// TicketKey signs upload tickets. Empty means confirmation is unavailable.
	TicketKey []byte
}
