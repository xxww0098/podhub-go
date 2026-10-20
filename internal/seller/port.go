package seller

import (
	"context"
	"errors"

	ozon "github.com/xxww0098/podhub-go/internal/platform/egressgate"
	submit "github.com/xxww0098/podhub-go/internal/seller/contract"
)

// Port is the submit.Transport view of this egress. The kill switch and the
// loopback check happen before a write is counted.
func (e *Egress) Port() submit.Transport { return port{e} }

type port struct{ e *Egress }

func (p port) WritesDisabled() bool { return p.e == nil || p.e.writesDisabled }

func (p port) Ready(context.Context) error {
	if p.e == nil || !p.e.Loopback() {
		return submit.ErrNotSent
	}
	return nil
}

func (p port) Write(ctx context.Context, path string, body []byte) (int, string, error) {
	if p.e == nil {
		return 0, "", submit.ErrNotSent
	}
	reply, err := p.e.Write(ctx, path, body)
	if errors.Is(err, ozon.ErrWritesDisabled) || errors.Is(err, ErrRefusedOrigin) {
		return 0, "", submit.ErrNotSent
	}
	if err != nil && reply.Status == 0 {
		return 0, "", err
	}
	return reply.Status, reply.Body, nil
}

func (p port) Read(ctx context.Context, path string, body []byte) (int, string, error) {
	if p.e == nil {
		return 0, "", submit.ErrNotSent
	}
	reply, err := p.e.Read(ctx, path, body)
	if errors.Is(err, ErrRefusedOrigin) {
		return 0, "", err
	}
	if err != nil && reply.Status == 0 {
		return 0, "", err
	}
	return reply.Status, reply.Body, nil
}
