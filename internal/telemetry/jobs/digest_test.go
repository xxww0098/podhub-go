package jobs

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/riverqueue/river"
)

func TestDigestWorkerDoesNotDecideBusinessState(t *testing.T) {
	if (DigestArgs{}).Kind() != "podhub.error_digest" {
		t.Fatal((DigestArgs{}).Kind())
	}
	var called bool
	worker := &DigestWorker{Run: func(context.Context, time.Time) error {
		called = true
		return nil
	}}
	if err := worker.Work(context.Background(), &river.Job[DigestArgs]{}); err != nil || !called {
		t.Fatal(err, called)
	}
	if err := (&DigestWorker{}).Work(context.Background(), &river.Job[DigestArgs]{}); err == nil {
		t.Fatal("unwired worker succeeded")
	}
	workers := river.NewWorkers()
	AddWorker(workers, func(context.Context, time.Time) error {
		return errors.New("not this test")
	})
	if river.AddWorkerSafely(workers, &DigestWorker{}) == nil {
		t.Fatal("digest worker was not added")
	}
}
