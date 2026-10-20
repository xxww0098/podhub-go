// Package queue wires River on the same Postgres pool as the API.
//
// River is the worker runner. The business result is the jobs row written
// by kernel.go (state, lease, attempt, idempotency), not a river_job_state.
// Differences and the tests that lock them are in
// docs/parity/queue-and-migration-differences.md. The noop River kind is still
// registered so the client can start; it is not a jobs claim.
package jobs

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// NoopArgs is the placeholder job. Workers do not enqueue it.
type NoopArgs struct{}

func (NoopArgs) Kind() string { return "podhub.noop" }

// NoopWorker acknowledges the placeholder kind. It does not touch Ozon or R2.
type NoopWorker struct {
	river.WorkerDefaults[NoopArgs]
}

func (NoopWorker) Work(context.Context, *river.Job[NoopArgs]) error { return nil }

// Addon registers extra River workers from the process assembly.
// The queue package does not import those workers.
type Addon struct {
	Register func(*river.Workers) []*river.PeriodicJob
}

// workSpan records one consumer span per River job attempt. It returns the
// worker's error unchanged.
var workSpan = river.WorkerMiddlewareFunc(func(ctx context.Context, job *rivertype.JobRow, doInner func(context.Context) error) error {
	ctx, span := otel.Tracer("podhub/river").Start(ctx, "river.work "+job.Kind,
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("river.kind", job.Kind),
			attribute.String("river.queue", job.Queue),
			attribute.Int64("river.job_id", job.ID),
			attribute.Int("river.attempt", job.Attempt),
		))
	defer span.End()
	err := doInner(ctx)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
	}
	return err
})

// Start runs a River client until ctx is cancelled or Stop is called.
// Addons may register periodic jobs. Those jobs are not jobs.state.
func Start(ctx context.Context, pool *pgxpool.Pool, addons ...Addon) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &NoopWorker{})
	var periodic []*river.PeriodicJob
	for _, addon := range addons {
		if addon.Register != nil {
			periodic = append(periodic, addon.Register(workers)...)
		}
	}
	client, err := river.NewClient(riverpgxv5.New(pool), runtimeConfig(workers, periodic))
	if err != nil {
		return nil, err
	}
	if err := client.Start(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

// runtimeConfig keeps runtime privileges separate from schema maintenance.
func runtimeConfig(workers *river.Workers, periodic []*river.PeriodicJob) *river.Config {
	return &river.Config{
		// Worker identities deliberately have no DDL privileges. Index maintenance
		// belongs to the migration/operator identity, not the runtime leader.
		ReindexerIndexNames: []string{},
		Schema:              "public",
		Logger:              slog.Default(),
		Middleware:          []rivertype.Middleware{workSpan},
		PeriodicJobs:        periodic,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 1},
		},
		Workers: workers,
	}
}
