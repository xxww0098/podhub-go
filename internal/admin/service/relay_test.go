package service

import (
	"context"
	"errors"
	"testing"
)

func TestRelayProbeReportsRealProbeOutcomeAndCancellation(t *testing.T) {
	for _, reachable := range []bool{true, false} {
		called := false
		svc := NewRelay(nil, RelayOptions{Route: "socks5h://sidecar:1080", Probe: func(ctx context.Context, route string) error {
			called = true
			if route != "socks5h://sidecar:1080" {
				t.Fatal("probe route changed")
			}
			if !reachable {
				return errors.New("proxy refused")
			}
			return nil
		}})
		got, err := svc.Probe(context.Background())
		if err != nil || !called || got.Data.Reachable != reachable || (got.Data.LatencyMs != nil) != reachable {
			t.Fatalf("reachable=%v view=%+v err=%v", reachable, got, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	svc := NewRelay(nil, RelayOptions{Route: "socks5h://sidecar:1080", Probe: func(ctx context.Context, _ string) error { return ctx.Err() }})
	got, err := svc.Probe(ctx)
	if err != nil || got.Data.Reachable {
		t.Fatal("canceled probe reported success")
	}
	got, err = NewRelay(nil, RelayOptions{}).Probe(context.Background())
	if err != nil || got.Data.Reachable || got.Data.LatencyMs != nil {
		t.Fatal("unconfigured relay reported success")
	}
}
