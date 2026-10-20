package egressgate

import (
	"testing"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func TestUnsetLeavesWritesOpenButUnsent(t *testing.T) {
	t.Setenv("OZON_WRITE_KILL_SWITCH", "")
	err := Send(config.Load(), "/v3/product/import")
	if err != ErrNotPorted {
		t.Fatalf("got %v", err)
	}
}

func TestTruthySwitchClosesWrites(t *testing.T) {
	for _, value := range []string{"1", "true", "yes", "on"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OZON_WRITE_KILL_SWITCH", value)
			err := Send(config.Load(), "/v3/product/import")
			if err != ErrWritesDisabled {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestOtherValuesLeaveWritesOpenButUnsent(t *testing.T) {
	for _, value := range []string{"0", "false", "maybe"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OZON_WRITE_KILL_SWITCH", value)
			err := Send(config.Load(), "/v3/product/import")
			if err != ErrNotPorted {
				t.Fatalf("got %v", err)
			}
		})
	}
}
