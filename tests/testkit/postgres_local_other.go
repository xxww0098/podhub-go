//go:build !linux

package testkit

import (
	"context"
	"fmt"
)

// startLocalPostgres is unavailable off Linux: the local starter relies on
// SysProcAttr.Pdeathsig. Docker is the only starter here, so a missing
// daemon is an error rather than a silent skip.
func startLocalPostgres(context.Context) (string, func(), error) {
	return "", nil, fmt.Errorf("local postgres starter is Linux-only; start Docker")
}
