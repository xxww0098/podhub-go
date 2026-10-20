package service

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
)

// BodyLimit is the business body cap. Over the cap is a validation error, not 413.
const BodyLimit = 2 * 1024 * 1024

// Admin is the three admin writes.
type Admin struct {
	Store domain.AdminStore
	Now   func() int64
	NewID func() string
}

// Dispatch validates JSON, then writes.
func (a Admin) Dispatch(ctx context.Context, userID int64, orderID string, body []byte, nowMS int64) (json.RawMessage, error) {
	if len(body) > BodyLimit {
		return nil, contract.Validation("请求格式无效")
	}
	in, err := domain.DecodeDispatch(body)
	if err != nil {
		return nil, err
	}
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return nil, contract.NotFound("委托单不存在")
	}
	return a.Store.Dispatch(ctx, a.cmd(userID, id, nowMS), in)
}

// Receipt validates JSON, then writes and settles in the same transaction.
func (a Admin) Receipt(ctx context.Context, userID int64, orderID string, body []byte, nowMS int64) (json.RawMessage, error) {
	if len(body) > BodyLimit {
		return nil, contract.Validation("请求格式无效")
	}
	in, err := domain.DecodeReceipt(body)
	if err != nil {
		return nil, err
	}
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return nil, contract.NotFound("委托单不存在")
	}
	return a.Store.Receipt(ctx, a.cmd(userID, id, nowMS), in)
}

// Cancel has no body. A terminal order is a conflict.
func (a Admin) Cancel(ctx context.Context, userID int64, orderID string, nowMS int64) (json.RawMessage, error) {
	id, ok := domain.NormalizeUUID(orderID)
	if !ok {
		return nil, contract.NotFound("委托单不存在")
	}
	return a.Store.Cancel(ctx, a.cmd(userID, id, nowMS))
}

func (a Admin) cmd(userID int64, orderID string, nowMS int64) domain.AdminCommand {
	if a.Now != nil {
		nowMS = a.Now()
	}
	newID := a.NewID
	if newID == nil {
		newID = uuid.NewString
	}
	return domain.AdminCommand{UserID: userID, OrderID: orderID, NowMS: nowMS, NewID: newID}
}
