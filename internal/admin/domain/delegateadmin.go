package domain

import (
	"strings"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	delegatecontract "github.com/xxww0098/podhub-go/internal/admin/delegate/contract"
)

var orderStates = []string{"awaiting_setup", "ready", "dispatched", "in_production", "shipped", "done", "cancelled"}

type (
	OrderQuery          = delegatecontract.OrderQuery
	SourceView          = delegatecontract.SourceView
	ReceiptView         = delegatecontract.ReceiptView
	OrderRow            = delegatecontract.OrderRow
	OrderListResponse   = delegatecontract.OrderListResponse
	LineView            = delegatecontract.LineView
	OrderView           = delegatecontract.OrderView
	LedgerRow           = delegatecontract.LedgerRow
	OrderDetailResponse = delegatecontract.OrderDetailResponse
)

// ParseOrderQuery validates the list query. Empty state and source do not filter.
func ParseOrderQuery(state, source string, org *int64, cursor string, limit *int64) (OrderQuery, *APIError) {
	state = strings.TrimSpace(state)
	if state != "" && !has(orderStates, state) {
		return OrderQuery{}, Fail(400, "validation", "state 过滤值无效")
	}
	q := OrderQuery{State: state, SourceID: strings.TrimSpace(source), Limit: pageLimit(limit)}
	if org != nil {
		q.OrgID = *org
	}
	cursor = strings.TrimSpace(cursor)
	if cursor != "" {
		ms, id, ok := DecodeCursor(cursor)
		if !ok {
			return OrderQuery{}, Fail(400, "validation", "cursor 无效")
		}
		q.CursorMS = &ms
		q.CursorID = id
	}
	return q, nil
}

func pageLimit(v *int64) int64 {
	n := int64(20)
	if v != nil {
		n = *v
	}
	if n < 1 {
		return 1
	}
	if n > 50 {
		return 50
	}
	return n
}

// DecodeCursor parses `{created_at_ms}:{uuid}` and returns the canonical uuid.
func DecodeCursor(s string) (int64, string, bool) {
	s = strings.TrimSpace(s)
	i := strings.IndexByte(s, ':')
	if i <= 0 || i == len(s)-1 {
		return 0, "", false
	}
	var ms int64
	neg := false
	num := s[:i]
	if num[0] == '-' {
		neg = true
		num = num[1:]
		if num == "" {
			return 0, "", false
		}
	}
	for _, c := range num {
		if c < '0' || c > '9' {
			return 0, "", false
		}
		ms = ms*10 + int64(c-'0')
	}
	if neg {
		ms = -ms
	}
	id, ok := CanonicalUUID(s[i+1:])
	if !ok {
		return 0, "", false
	}
	return ms, id, true
}

func itoa64(n int64) string { return corecontract.Itoa64(n) }
