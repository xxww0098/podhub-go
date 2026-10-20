package queue

import (
	"context"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	ozon "github.com/xxww0098/podhub-go/internal/platform/egressgate"
	"github.com/xxww0098/podhub-go/internal/queue/domain"
	"github.com/xxww0098/podhub-go/internal/queue/service"
)

func TestPermitClassAndHeadExclusion(t *testing.T) {
	if domain.PermitClass("ai.recognize") != "ai_ocr" || domain.PermitClass("media.upload") != "cloud_upload" || domain.PermitClass("listing.submit") != "all_execution" {
		t.Fatal("permit class drifted")
	}
	if domain.CountsTowardHead("media.render", "browser") || domain.CountsTowardHead("media.upload", "browser") {
		t.Fatal("browser media must not move the head")
	}
	if !domain.CountsTowardHead("media.render", "") || !domain.CountsTowardHead("listing.submit", "http") {
		t.Fatal("cloud media and http jobs still count")
	}
	if domain.ClampLaneLimit(0) != 1 || domain.ClampLaneLimit(5000) != domain.LaneQueuedCostLimitCeiling || domain.ClampLaneLimit(256) != 256 {
		t.Fatal("lane clamp drifted")
	}
	if !domain.SellerWriteKind("listing.submit") || !domain.SellerWriteKind("listing.submit.batch") || domain.SellerWriteKind("listing.reconcile") {
		t.Fatal("write kinds drifted")
	}
}

func TestScanSchedule(t *testing.T) {
	t.Setenv("OZON_PRODUCT_SYNC_DISABLED", "")
	t.Setenv("DELEGATE_SYNC_INTERVAL_MS", "")
	cfg := config.Load()
	scans := service.Schedules(cfg)
	want := []string{
		"UnknownWritesScan",
		"ProductSyncScan",
		"ProductSyncCleanupScan",
		"DelegateSyncScan",
		"UnknownImportsScan",
		"ProductGroupingScan",
		"AcceptedImportsScan",
	}
	if len(scans) != len(want) {
		t.Fatalf("scans %d", len(scans))
	}
	for i, name := range want {
		if scans[i].Name != name {
			t.Fatalf("scan %d %s", i, scans[i].Name)
		}
	}
	if scans[0].Base != 5*time.Second || scans[0].IdleMax != 60*time.Second || scans[0].Batch != 16 {
		t.Fatalf("unknown writes %+v", scans[0])
	}
	// The sync scan wakes ENQUEUE_BATCH_LIMIT stores per round, the same 32
	// the scheduler materializes in one materialize pass.
	if scans[1].Base != 30*time.Second || scans[1].IdleMax != 10*time.Minute || scans[1].Batch != 32 {
		t.Fatalf("product sync %+v", scans[1])
	}
	if scans[2].Batch != 1 || scans[3].IdleMax != 0 || scans[3].Base != time.Minute {
		t.Fatalf("cleanup %+v delegate %+v", scans[2], scans[3])
	}
	if service.NextInterval(5*time.Second, 60*time.Second, 5*time.Second, true) != 10*time.Second {
		t.Fatal("idle doubles")
	}
	if service.NextInterval(5*time.Second, 60*time.Second, 40*time.Second, true) != 60*time.Second {
		t.Fatal("idle stops at the cap")
	}
	if service.NextInterval(5*time.Second, 60*time.Second, 40*time.Second, false) != 5*time.Second {
		t.Fatal("work returns to the base interval")
	}
	if service.NextInterval(time.Minute, 0, time.Minute, true) != time.Minute {
		t.Fatal("delegate scan does not back off")
	}
	if got := service.NextInterval(scans[3].Base, scans[3].IdleMax, scans[3].Base, true); got != scans[3].Base {
		t.Fatalf("delegate interval %s", got)
	}
}

func TestProductSyncDisabledDropsOnlyThatScan(t *testing.T) {
	t.Setenv("OZON_PRODUCT_SYNC_DISABLED", "yes")
	active := service.Active(service.Schedules(config.Load()))
	if len(active) != 6 {
		t.Fatalf("active %d", len(active))
	}
	for _, scan := range active {
		if scan.Name == "ProductSyncScan" {
			t.Fatal("disabled product sync must not start")
		}
	}
}

func TestScanPanicAndDisableAreIdle(t *testing.T) {
	called := false
	idle := service.RunOnce(context.Background(), service.DueScan{
		Name:    "UnknownWritesScan",
		Enabled: func() bool { return false },
		Tick: func(context.Context) (bool, error) {
			called = true
			return true, nil
		},
	})
	if !idle || called {
		t.Fatal("disabled scan must not tick")
	}
	idle = service.RunOnce(context.Background(), service.DueScan{
		Name: "ProductGroupingScan",
		Tick: func(context.Context) (bool, error) { panic("boom") },
	})
	if !idle {
		t.Fatal("panic is an idle round")
	}
}

func TestExecuteObeysKillSwitchAndDoesNotTreatReadsAsWrites(t *testing.T) {
	t.Setenv("OZON_WRITE_KILL_SWITCH", "on")
	cfg := config.Load()
	if err := service.Execute(cfg, "listing.submit"); err != ozon.ErrWritesDisabled {
		t.Fatalf("write: %v", err)
	}
	if err := service.Execute(cfg, "listing.submit.batch"); err != ozon.ErrWritesDisabled {
		t.Fatalf("batch: %v", err)
	}
	if err := service.Execute(cfg, "listing.reconcile"); err != service.ErrWorkNotPorted {
		t.Fatalf("reconcile probe: %v", err)
	}
	if err := service.Execute(cfg, "store.product_sync"); err != service.ErrWorkNotPorted {
		t.Fatalf("sync read: %v", err)
	}
	if !service.NotPorted(errSent()) {
		t.Fatal("not ported must be withdrawn, not completed")
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	if err := service.Execute(config.Load(), "listing.submit"); err != ozon.ErrNotPorted {
		t.Fatalf("open switch still must not dial, got %v", err)
	}
}

func errSent() error { return ozon.ErrNotPorted }

func TestRoleKinds(t *testing.T) {
	if got := service.KindsForRole("listing"); len(got) != 2 || got[0] != "listing.submit" || got[1] != "listing.submit.batch" {
		t.Fatalf("listing %v", got)
	}
	if got := service.KindsForRole("sync"); len(got) != 1 || got[0] != "store.product_sync" {
		t.Fatalf("sync %v", got)
	}
	if got := service.KindsForRole("reconcile"); len(got) != 2 || got[0] != "listing.reconcile" || got[1] != "delegate.posting_sync" {
		t.Fatalf("reconcile %v", got)
	}
	if service.KindsForRole("media-gc") != nil {
		t.Fatal("media gc is not a jobs claimer")
	}
}
