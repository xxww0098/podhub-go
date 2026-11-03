package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/xxww0098/podhub-go/internal/identity"
)

// Independent from catalog/billing timers: SMTP latency cannot stall them.
func runPasswordRecovery(ctx context.Context, svc *identity.Service) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if _, err := svc.DeliverPasswordResets(ctx, 4); err != nil && ctx.Err() == nil {
			// Driver errors can contain parameter values. Do not log recovery secrets.
			slog.Error("password recovery delivery unavailable")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
