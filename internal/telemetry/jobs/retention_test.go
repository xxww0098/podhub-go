package jobs

import (
	"context"
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/telemetry/contract"
)

func TestRetentionDeletesNothing(t *testing.T) {
	got, err := Run(context.Background())
	if !errors.Is(err, contract.ErrNotPorted) || got.Deleted != 0 {
		t.Fatalf("%+v %v", got, err)
	}
}
