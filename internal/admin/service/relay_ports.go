package service

import (
	"context"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// RelayPort records an audit row after the files are saved. A failure is ignored by the service.
type RelayPort interface {
	Audit(ctx context.Context, a domain.Audit) error
}

// RelayOptions is the nodes directory. SwitchDir is the sidecar active-file directory.
// Route is the first socks5h label; empty means Seller calls go direct.
type RelayOptions struct {
	Now       func() time.Time
	Dir       string
	SwitchDir string
	Route     string
}
