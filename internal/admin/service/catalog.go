package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Catalog is the admin platform catalog use case.
type Catalog struct {
	port CatalogPort
	opt  CatalogOptions
}

// NewCatalog keeps the port. A nil Now uses time.Now.
func NewCatalog(p CatalogPort, opt CatalogOptions) *Catalog {
	return &Catalog{port: p, opt: opt}
}

func (s *Catalog) now() int64 {
	if s != nil && s.opt.Now != nil {
		return s.opt.Now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

func (s *Catalog) mint(prefix string) string {
	id := ""
	if s != nil && s.opt.NewID != nil {
		id = s.opt.NewID()
	}
	if id == "" {
		var b [16]byte
		_, _ = rand.Read(b[:])
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		id = hex.EncodeToString(b[:])
	}
	return prefix + "_" + id
}

func (s *Catalog) actor(a domain.Actor) domain.Actor {
	if a.OrgID < 0 {
		a.OrgID = 0
	}
	return a
}

func (s *Catalog) bases(ctx context.Context) ([]string, error) {
	if s.opt.Media != nil {
		out := make([]string, 0, len(s.opt.Media))
		for _, a := range s.opt.Media {
			if a.PublicBaseURL != "" {
				out = append(out, a.PublicBaseURL)
			}
		}
		return out, nil
	}
	if s.port == nil {
		return nil, domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	return s.port.Bases(ctx)
}

// List returns every product and SKU. It does not audit.
func (s *Catalog) List(ctx context.Context) (domain.CatalogList, error) {
	products, skus, err := s.port.List(ctx)
	if err != nil {
		return domain.CatalogList{}, err
	}
	if products == nil {
		products = []domain.Product{}
	}
	if skus == nil {
		skus = []domain.SKU{}
	}
	for i := range products {
		products[i] = domain.FillProduct(products[i])
	}
	for i := range skus {
		skus[i] = domain.FillSKU(skus[i])
	}
	var out domain.CatalogList
	out.Data.Products = products
	out.Data.SKUs = skus
	return out, nil
}

// CreateProduct inserts an unpublished revision-1 row.
func (s *Catalog) CreateProduct(ctx context.Context, actor domain.Actor, raw []byte) (domain.ProductMutation, error) {
	bases, err := s.bases(ctx)
	if err != nil {
		return domain.ProductMutation{}, err
	}
	in, err := domain.ParseCreateProduct(raw, bases)
	if err != nil {
		return domain.ProductMutation{}, err
	}
	row, err := s.port.CreateProduct(ctx, s.actor(actor), s.mint("scp"), in, s.now())
	if err != nil {
		return domain.ProductMutation{}, err
	}
	var out domain.ProductMutation
	out.Data.Product = domain.FillProduct(row)
	return out, nil
}

// UpdateProduct applies a CAS update and refuses supplier-managed rows.
func (s *Catalog) UpdateProduct(ctx context.Context, actor domain.Actor, id string, raw []byte) (domain.ProductMutation, error) {
	bases, err := s.bases(ctx)
	if err != nil {
		return domain.ProductMutation{}, err
	}
	in, err := domain.ParseUpdateProduct(raw, bases)
	if err != nil {
		return domain.ProductMutation{}, err
	}
	row, err := s.port.UpdateProduct(ctx, s.actor(actor), id, in, s.now())
	if err != nil {
		return domain.ProductMutation{}, err
	}
	var out domain.ProductMutation
	out.Data.Product = domain.FillProduct(row)
	return out, nil
}

// PublishProduct sets published without requiring a price.
func (s *Catalog) PublishProduct(ctx context.Context, actor domain.Actor, id string, raw []byte, published bool) (domain.ProductMutation, error) {
	rev, err := domain.ParseCAS(raw)
	if err != nil {
		return domain.ProductMutation{}, err
	}
	row, err := s.port.SetProductPublished(ctx, s.actor(actor), id, rev, published, s.now())
	if err != nil {
		return domain.ProductMutation{}, err
	}
	var out domain.ProductMutation
	out.Data.Product = domain.FillProduct(row)
	return out, nil
}

// CreateSKU inserts an unpublished SKU under an unmanaged product.
func (s *Catalog) CreateSKU(ctx context.Context, actor domain.Actor, raw []byte) (domain.SKUMutation, error) {
	bases, err := s.bases(ctx)
	if err != nil {
		return domain.SKUMutation{}, err
	}
	in, err := domain.ParseCreateSKU(raw, bases)
	if err != nil {
		return domain.SKUMutation{}, err
	}
	row, err := s.port.CreateSKU(ctx, s.actor(actor), s.mint("scs"), in, s.now())
	if err != nil {
		return domain.SKUMutation{}, err
	}
	var out domain.SKUMutation
	out.Data.SKU = domain.FillSKU(row)
	return out, nil
}

// UpdateSKU changes title, media, specs, and lead time.
func (s *Catalog) UpdateSKU(ctx context.Context, actor domain.Actor, id string, raw []byte) (domain.SKUMutation, error) {
	bases, err := s.bases(ctx)
	if err != nil {
		return domain.SKUMutation{}, err
	}
	in, err := domain.ParseUpdateSKU(raw, bases)
	if err != nil {
		return domain.SKUMutation{}, err
	}
	row, err := s.port.UpdateSKU(ctx, s.actor(actor), id, in, s.now())
	if err != nil {
		return domain.SKUMutation{}, err
	}
	var out domain.SKUMutation
	out.Data.SKU = domain.FillSKU(row)
	return out, nil
}

// SetPrice appends a price version and bumps the SKU revision.
func (s *Catalog) SetPrice(ctx context.Context, actor domain.Actor, id string, raw []byte) (domain.SKUMutation, error) {
	rev, cents, err := domain.ParsePrice(raw)
	if err != nil {
		return domain.SKUMutation{}, err
	}
	row, err := s.port.SetPrice(ctx, s.actor(actor), id, rev, cents, s.now())
	if err != nil {
		return domain.SKUMutation{}, err
	}
	var out domain.SKUMutation
	out.Data.SKU = domain.FillSKU(row)
	return out, nil
}

// PublishSKU requires a current price. Unpublish does not.
func (s *Catalog) PublishSKU(ctx context.Context, actor domain.Actor, id string, raw []byte, published bool) (domain.SKUMutation, error) {
	rev, err := domain.ParseCAS(raw)
	if err != nil {
		return domain.SKUMutation{}, err
	}
	if published {
		target, err := s.port.ImageTarget(ctx, "sku", id)
		if err != nil {
			return domain.SKUMutation{}, err
		}
		if !target.Exists {
			return domain.SKUMutation{}, domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		if target.PriceCents == nil {
			return domain.SKUMutation{}, domain.Fail(400, "VALIDATION", "请先设置平台价")
		}
		if target.Revision != rev {
			return domain.SKUMutation{}, domain.Fail(409, "CONFLICT", "记录已被更新，请刷新后重试")
		}
	}
	row, err := s.port.SetSKUPublished(ctx, s.actor(actor), id, rev, published, s.now())
	if err != nil {
		return domain.SKUMutation{}, err
	}
	var out domain.SKUMutation
	out.Data.SKU = domain.FillSKU(row)
	return out, nil
}
