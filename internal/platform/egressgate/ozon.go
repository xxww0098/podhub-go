// Package ozon is the only place a Seller write may be attempted.
// The skeleton has no HTTP client and does not know api-seller.ozon.ru as a
// dial target. AllowWrite returns ErrWritesDisabled only when
// OZON_WRITE_KILL_SWITCH is truthy (src/store/egress.rs). Every other value,
// including unset, leaves the gate open; Send then returns ErrNotPorted
// before any network call. Reads are not gated here.
package egressgate

import (
	"errors"
	"fmt"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

// ErrWritesDisabled is returned when OZON_WRITE_KILL_SWITCH is truthy.
// Rust's message is "OZON_WRITE_KILL_SWITCH 已启用，Ozon 实时写入已停止".
var ErrWritesDisabled = errors.New("OZON_WRITE_KILL_SWITCH is engaged; Ozon writes are closed")

// ErrNotPorted means the write was not blocked by the kill switch and then
// refused because this skeleton does not send Seller traffic.
var ErrNotPorted = errors.New("ozon write is not ported; no request was sent")

// AllowWrite is the gate every future Seller write must call first.
func AllowWrite(cfg config.Config) error {
	if cfg.OzonWritesDisabled() {
		return ErrWritesDisabled
	}
	return nil
}

// Send is the write entry. It never dials.
func Send(cfg config.Config, path string) error {
	if err := AllowWrite(cfg); err != nil {
		return err
	}
	if path == "" {
		return fmt.Errorf("ozon write: empty path")
	}
	return ErrNotPorted
}
