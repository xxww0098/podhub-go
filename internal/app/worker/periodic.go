package worker

import (
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	queuejobs "github.com/xxww0098/podhub-go/internal/queue/jobs"
	ratingdomain "github.com/xxww0098/podhub-go/internal/ratings/domain"
	ratingjobs "github.com/xxww0098/podhub-go/internal/ratings/jobs"
	telemetryjobs "github.com/xxww0098/podhub-go/internal/telemetry/jobs"
)

// periodicJob is one River periodic job. ID is River's PeriodicJobOpts.ID,
// which must be unique across the client. RunOnStart false means the first
// insert waits one interval, so a boot does not run every job at once.
type periodicJob struct {
	Args       river.JobArgs
	ID         string
	Interval   time.Duration
	RunOnStart bool
}

// periodicJobs is every River schedule the queue workers start. A new
// periodic job is added here; its worker is added by its domain's jobs package.
func periodicJobs(cfg config.Config) []periodicJob {
	return []periodicJob{
		{Args: telemetryjobs.DigestArgs{}, ID: "error-digest-hourly", Interval: time.Hour},
		{Args: ratingjobs.SyncArgs{}, ID: "store-rating-sync", Interval: ratingdomain.Tick(cfg.RatingSyncInterval())},
		{Args: ratingjobs.PruneArgs{}, ID: "store-rating-prune", Interval: time.Hour},
	}
}

func periodicAddon(cfg config.Config) queuejobs.Addon {
	return queuejobs.Addon{Register: func(*river.Workers) []*river.PeriodicJob {
		var out []*river.PeriodicJob
		for _, p := range periodicJobs(cfg) {
			args := p.Args
			out = append(out, river.NewPeriodicJob(
				river.PeriodicInterval(p.Interval),
				func() (river.JobArgs, *river.InsertOpts) { return args, nil },
				&river.PeriodicJobOpts{ID: p.ID, RunOnStart: p.RunOnStart},
			))
		}
		return out
	}}
}

// riverAddons is what queue.Start receives: the workers, then the schedules.
func riverAddons(pool *pgxpool.Pool, cfg config.Config) []queuejobs.Addon {
	return []queuejobs.Addon{errorDigestAddon(pool), ratingAddon(pool, cfg), periodicAddon(cfg)}
}
