package service

import (
	"errors"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	ozon "github.com/xxww0098/podhub-go/internal/platform/egressgate"
)

// ErrWorkNotPorted means the job body is not the Seller call yet.
// The claim loop must not report the row as succeeded.
var ErrWorkNotPorted = errors.New("job body is not ported; no Ozon request was sent")

// Execute is the only job body the process runs.
//
// listing.submit and listing.submit.batch go through ozon.Send, which
// applies OZON_WRITE_KILL_SWITCH and does not dial. Every other kind is a
// read or a reconcile probe: the switch does not apply, and this function
// still does not dial.
func Execute(cfg config.Config, kind string) error {
	if SellerWriteKind(kind) {
		return ozon.Send(cfg, "/v3/product/import")
	}
	return ErrWorkNotPorted
}

// NotPorted reports errors the loop turns into a withdrawn requeue.
// Writes-disabled, the unported send, and a non-write kind all stop here.
// None of them is a successful Seller write.
func NotPorted(err error) bool {
	return errors.Is(err, ErrWorkNotPorted) ||
		errors.Is(err, ozon.ErrNotPorted) ||
		errors.Is(err, ozon.ErrWritesDisabled)
}
