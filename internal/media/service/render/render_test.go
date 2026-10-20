package render

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
)

func TestAcceptCurrentKey(t *testing.T) {
	now := time.Date(2026, 10, 15, 20, 4, 14, 0, time.UTC)
	workspace := "550e8400-e29b-41d4-a716-446655440000"
	digest := strings.Repeat("cd", 32)
	got, err := Accept(Receipt{
		Workspace: workspace,
		Digest:    digest,
		Ext:       "png",
		Batch:     strconv.FormatInt(now.UnixMilli(), 10) + "." + workspace,
		NotBefore: time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != Kind || got.Executor != Executor || got.CostUnits != 8 || !got.Current {
		t.Fatalf("%+v", got)
	}
	if got.Digest != digest || got.Ext != "png" || got.BatchMS != now.UnixMilli() {
		t.Fatalf("%+v", got)
	}
}

func TestAcceptRejectsProbeAndStale(t *testing.T) {
	workspace := "550e8400-e29b-41d4-a716-446655440000"
	_, err := Accept(Receipt{Workspace: workspace, Digest: objectkey.HealthcheckDigest(), Ext: "png", Batch: "1." + workspace})
	if err != ErrProbe {
		t.Fatalf("probe: %v", err)
	}
	issued := time.Date(2026, 10, 15, 19, 0, 0, 0, time.UTC)
	_, err = Accept(Receipt{
		Workspace: workspace,
		Digest:    strings.Repeat("cd", 32),
		Ext:       "jpg",
		Batch:     strconv.FormatInt(issued.UnixMilli(), 10) + "." + workspace,
		NotBefore: time.Date(2026, 10, 15, 20, 0, 0, 0, time.UTC),
	})
	if err != ErrStale || !strings.Contains(err.Error(), "图片已进入不可逆回收") {
		t.Fatalf("stale: %v", err)
	}
}
