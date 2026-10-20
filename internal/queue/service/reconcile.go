package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	UnknownWritesBatch   = 16
	ImportScanBatch      = 16
	ProductCleanupBatch  = 1
	ProductSyncBatch     = 32
	unknownWritesIdleMax = 60 * time.Second
	productSyncIdleMax   = 10 * time.Minute
)

// Schedules is the seven scans. Product sync is omitted from Active when
// OZON_PRODUCT_SYNC_DISABLED was truthy at process start. Delegate sync
// uses DELEGATE_SYNC_INTERVAL_MS and does not back off.
func Schedules(cfg config.Config) []DueScan {
	idle := func(context.Context) (bool, error) { return false, nil }
	return []DueScan{
		{Name: "UnknownWritesScan", Base: 5 * time.Second, IdleMax: unknownWritesIdleMax, Batch: UnknownWritesBatch, Tick: idle},
		{Name: "ProductSyncScan", Base: 30 * time.Second, IdleMax: productSyncIdleMax, Batch: ProductSyncBatch, Enabled: func() bool { return !cfg.ProductSyncDisabled() }, Tick: idle},
		{Name: "ProductSyncCleanupScan", Base: 30 * time.Second, IdleMax: productSyncIdleMax, Batch: ProductCleanupBatch, Tick: idle},
		{Name: "DelegateSyncScan", Base: cfg.DelegateSyncInterval(), IdleMax: 0, Tick: idle},
		{Name: "UnknownImportsScan", Base: 5 * time.Second, IdleMax: unknownWritesIdleMax, Batch: ImportScanBatch, Tick: idle},
		{Name: "ProductGroupingScan", Base: 5 * time.Second, IdleMax: unknownWritesIdleMax, Batch: ImportScanBatch, Tick: idle},
		{Name: "AcceptedImportsScan", Base: 5 * time.Second, IdleMax: unknownWritesIdleMax, Batch: ImportScanBatch, Tick: idle},
	}
}

// Active drops scans whose Enabled func is false. The decision is the
// config captured at process start.
func Active(scans []DueScan) []DueScan {
	out := make([]DueScan, 0, len(scans))
	for _, scan := range scans {
		if scan.Enabled != nil && !scan.Enabled() {
			continue
		}
		out = append(out, scan)
	}
	return out
}

// NextInterval doubles after an idle round until IdleMax. IdleMax 0 keeps
// Base, which is the delegate scan (no backoff). A round that did work
// returns to Base.
func NextInterval(base, idleMax, current time.Duration, idle bool) time.Duration {
	if idleMax <= 0 || !idle {
		return base
	}
	if current < base {
		current = base
	}
	next := current * 2
	if next > idleMax {
		return idleMax
	}
	return next
}

// RunOnce runs one scan. A disabled scan, an error, or a panic is an idle
// round. The scan does not take an execution permit.
func RunOnce(ctx context.Context, scan DueScan) (idle bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("reconcile scan panicked", "scan", scan.Name, "panic", recovered)
			idle = true
		}
	}()
	if scan.Enabled != nil && !scan.Enabled() {
		return true
	}
	if scan.Tick == nil {
		return true
	}
	worked, err := scan.Tick(ctx)
	if err != nil {
		slog.Error("reconcile scan", "scan", scan.Name, "err", err)
		return true
	}
	return !worked
}

// RunScans starts one loop per active scan. They stop when ctx is cancelled.
func RunScans(ctx context.Context, scans []DueScan) {
	for _, scan := range Active(scans) {
		go runScan(ctx, scan)
	}
}

func runScan(ctx context.Context, scan DueScan) {
	interval := scan.Base
	if interval <= 0 {
		interval = time.Second
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			idle := RunOnce(ctx, scan)
			interval = NextInterval(scan.Base, scan.IdleMax, interval, idle)
			timer.Reset(interval)
		}
	}
}

// TrySeat takes the single reconciler advisory lock on this session.
// The caller keeps the connection. Closing it releases the lock.
func TrySeat(ctx context.Context, conn seatConn) (bool, error) {
	var ok bool
	err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, ReconcilerAdvisoryLock).Scan(&ok)
	return ok, err
}

type seatConn interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}
