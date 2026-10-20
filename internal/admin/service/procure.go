package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Procure is the admin procurement use case.
type Procure struct {
	port ProcurePort
	opt  ProcureOptions
}

// NewProcure keeps the port.
func NewProcure(p ProcurePort, opt ProcureOptions) *Procure {
	return &Procure{port: p, opt: opt}
}

func (s *Procure) now() int64 {
	if s != nil && s.opt.Now != nil {
		return s.opt.Now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

func (s *Procure) mint(prefix string) string {
	id := ""
	if s != nil && s.opt.NewID != nil {
		id = strings.ReplaceAll(s.opt.NewID(), "-", "")
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

func (s *Procure) actor(a domain.Actor) domain.Actor {
	if a.OrgID < 0 {
		a.OrgID = 0
	}
	return a
}

// List returns the work queue. It does not audit.
func (s *Procure) List(ctx context.Context) (domain.WorkList, error) {
	items, err := s.port.List(ctx)
	if err != nil {
		return domain.WorkList{}, err
	}
	if items == nil {
		items = []domain.WorkItem{}
	}
	for i := range items {
		items[i] = domain.FillWork(items[i])
	}
	var out domain.WorkList
	out.Data.Items = items
	return out, nil
}

// Claim opens or refreshes a prepared attempt.
func (s *Procure) Claim(ctx context.Context, actor domain.Actor, raw []byte) (domain.WorkItemResponse, error) {
	in, err := domain.ParseClaim(raw)
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	item, err := s.port.Claim(ctx, s.actor(actor), in, s.mint("scp"), s.mint("scop"), s.now())
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	var out domain.WorkItemResponse
	out.Data.Item = domain.FillWork(item)
	return out, nil
}

// Dispatch moves a live claim to dispatching.
func (s *Procure) Dispatch(ctx context.Context, actor domain.Actor, id string) (domain.WorkItemResponse, error) {
	id, err := domain.RequireProcID(id)
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	item, err := s.port.Dispatch(ctx, s.actor(actor), id, s.now())
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	var out domain.WorkItemResponse
	out.Data.Item = domain.FillWork(item)
	return out, nil
}

// Receipt records accepted, rejected, or unknown.
func (s *Procure) Receipt(ctx context.Context, actor domain.Actor, id string, raw []byte) (domain.WorkItemResponse, error) {
	id, err := domain.RequireProcID(id)
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	in, err := domain.ParseReceipt(raw)
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	item, err := s.port.Receipt(ctx, s.actor(actor), id, in, s.now())
	if err != nil {
		return domain.WorkItemResponse{}, err
	}
	var out domain.WorkItemResponse
	out.Data.Item = domain.FillWork(item)
	return out, nil
}

// Refund stamps the order once.
func (s *Procure) Refund(ctx context.Context, actor domain.Actor, id string) (domain.RefundResponse, error) {
	id, err := domain.RequireOrderID(id)
	if err != nil {
		return domain.RefundResponse{}, err
	}
	orderID, at, err := s.port.Refund(ctx, s.actor(actor), id, s.now())
	if err != nil {
		return domain.RefundResponse{}, err
	}
	var out domain.RefundResponse
	out.Data.OrderID = orderID
	out.Data.RefundAtMS = at
	return out, nil
}
