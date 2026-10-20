package app

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"

	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	ozon "github.com/xxww0098/podhub-go/internal/platform/egressgate"
	"github.com/xxww0098/podhub-go/internal/seller"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
	shippingsvc "github.com/xxww0098/podhub-go/internal/shipping/service"
)

type delegatePort struct{ inner delegatesvc.Admin }

func (p delegatePort) Dispatch(ctx context.Context, userID int64, orderID string, body []byte, nowMS int64) (json.RawMessage, error) {
	return p.inner.Dispatch(ctx, userID, orderID, body, nowMS)
}

func (p delegatePort) Receipt(ctx context.Context, userID int64, orderID string, body []byte, nowMS int64) (json.RawMessage, error) {
	return p.inner.Receipt(ctx, userID, orderID, body, nowMS)
}

func (p delegatePort) Cancel(ctx context.Context, userID int64, orderID string, nowMS int64) (json.RawMessage, error) {
	return p.inner.Cancel(ctx, userID, orderID, nowMS)
}

type shippingPort struct{ inner shippingsvc.Admin }

func (p shippingPort) Reconcile(ctx context.Context, storeUUID, presetID string, now int64) (json.RawMessage, error) {
	return p.inner.Reconcile(ctx, storeUUID, presetID, now)
}

func (p shippingPort) SafeContinue(ctx context.Context, storeUUID, presetID, actor string, now int64) (json.RawMessage, error) {
	return p.inner.SafeContinue(ctx, storeUUID, presetID, actor, now)
}

// shippingOzon dials loopback only. The kill switch is the bool already on the egress.
type shippingOzon struct{ egress *seller.Egress }

func (p shippingOzon) Post(ctx context.Context, path string, body []byte, write bool, clientID, apiKey string) (int, []byte, error) {
	if p.egress == nil {
		return 0, nil, &domain.CallError{Connect: true, Transport: true}
	}
	reply, err := p.egress.Call(ctx, http.MethodPost, path, body, write, true, clientID, apiKey)
	if err != nil {
		if errors.Is(err, ozon.ErrWritesDisabled) {
			return 0, nil, errors.New("OZON_WRITE_KILL_SWITCH 已启用，Ozon 实时写入已停止")
		}
		ce := &domain.CallError{Transport: true}
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return 0, nil, ce
		}
		ce.Connect = true
		return 0, nil, ce
	}
	return reply.Status, []byte(reply.Body), nil
}
