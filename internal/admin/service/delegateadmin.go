package service

import (
	"context"
	"strconv"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// DelegateAdmin is the platform queue for delegate orders.
type DelegateAdmin struct {
	port DelegatePort
}

// NewDelegateAdmin keeps the read port.
func NewDelegateAdmin(p DelegatePort) *DelegateAdmin {
	return &DelegateAdmin{port: p}
}

// List validates the query, then reads under staff access.
func (s *DelegateAdmin) List(ctx context.Context, state, source, org, cursor, limit string) (domain.OrderListResponse, error) {
	var orgID *int64
	if stringsTrim(org) != "" {
		n, err := strconv.ParseInt(stringsTrim(org), 10, 64)
		if err != nil {
			return domain.OrderListResponse{}, domain.Fail(400, "validation", "请求格式无效")
		}
		orgID = &n
	}
	var lim *int64
	if stringsTrim(limit) != "" {
		n, err := strconv.ParseInt(stringsTrim(limit), 10, 64)
		if err != nil {
			return domain.OrderListResponse{}, domain.Fail(400, "validation", "请求格式无效")
		}
		lim = &n
	}
	q, err := domain.ParseOrderQuery(state, source, orgID, cursor, lim)
	if err != nil {
		return domain.OrderListResponse{}, err
	}
	return s.port.List(ctx, q)
}

// Get returns one order across orgs.
func (s *DelegateAdmin) Get(ctx context.Context, orderID string) (domain.OrderDetailResponse, error) {
	id, ok := domain.CanonicalUUID(orderID)
	if !ok {
		return domain.OrderDetailResponse{}, domain.Fail(404, "not_found", "委托单不存在")
	}
	return s.port.Get(ctx, id)
}

// Dispatch stops after the path uuid. The settlement SQL is unconfirmed.
func (s *DelegateAdmin) Dispatch(orderID string) error {
	return s.unported(orderID)
}

// Receipt stops after the path uuid. settle_seller / quote_dispatch are unconfirmed.
func (s *DelegateAdmin) Receipt(orderID string) error {
	return s.unported(orderID)
}

// Cancel stops after the path uuid. release_seller is unconfirmed.
func (s *DelegateAdmin) Cancel(orderID string) error {
	return s.unported(orderID)
}

func (s *DelegateAdmin) unported(orderID string) error {
	if _, ok := domain.CanonicalUUID(orderID); !ok {
		return domain.Fail(404, "not_found", "委托单不存在")
	}
	// unconfirmed: quote_dispatch / hold_seller / settle_seller / release_seller / credit_dispatch SQL bodies.
	return domain.NotPorted()
}

func stringsTrim(s string) string {
	i, j := 0, len(s)
	for i < j && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	for j > i && (s[j-1] == ' ' || s[j-1] == '\t' || s[j-1] == '\n' || s[j-1] == '\r') {
		j--
	}
	return s[i:j]
}
