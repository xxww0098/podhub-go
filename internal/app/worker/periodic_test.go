package worker

import (
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/riverqueue/river"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	ratingjobs "github.com/xxww0098/podhub-go/internal/ratings/jobs"
	telemetryjobs "github.com/xxww0098/podhub-go/internal/telemetry/jobs"
)

type periodicRow struct {
	Kind       string
	ID         string
	Interval   time.Duration
	RunOnStart bool
}

// field reads an unexported field of river.PeriodicJob. River exposes no
// getter, and this test must see exactly what the client receives.
func field(job *river.PeriodicJob, name string) any {
	v := reflect.ValueOf(job).Elem().FieldByName(name)
	return reflect.NewAt(v.Type(), unsafe.Pointer(v.UnsafeAddr())).Elem().Interface()
}

func registeredPeriodic(t *testing.T, cfg config.Config) []periodicRow {
	t.Helper()
	workers := river.NewWorkers()
	var rows []periodicRow
	for _, addon := range riverAddons(nil, cfg) {
		for _, job := range addon.Register(workers) {
			args, _ := field(job, "constructorFunc").(river.PeriodicJobConstructor)()
			opts := field(job, "opts").(*river.PeriodicJobOpts)
			t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			next := field(job, "scheduleFunc").(river.PeriodicSchedule).Next(t0)
			rows = append(rows, periodicRow{Kind: args.Kind(), ID: opts.ID, Interval: next.Sub(t0), RunOnStart: opts.RunOnStart})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Kind < rows[j].Kind })
	return rows
}

func TestRiverPeriodicJobsUnchanged(t *testing.T) {
	cases := []struct {
		sync string
		tick time.Duration
	}{
		{"", 15 * time.Minute},
		{"5m", 5 * time.Minute},
		{"24h", 15 * time.Minute},
	}
	for _, c := range cases {
		t.Setenv("STORE_RATING_SYNC_INTERVAL", c.sync)
		want := []periodicRow{
			{Kind: "podhub.error_digest", ID: "error-digest-hourly", Interval: time.Hour},
			{Kind: "podhub.store_rating_prune", ID: "store-rating-prune", Interval: time.Hour},
			{Kind: "podhub.store_rating_sync", ID: "store-rating-sync", Interval: c.tick},
		}
		if got := registeredPeriodic(t, config.Load()); !reflect.DeepEqual(got, want) {
			t.Fatalf("STORE_RATING_SYNC_INTERVAL=%q\n got %+v\nwant %+v", c.sync, got, want)
		}
	}
}

func TestPeriodicTableShape(t *testing.T) {
	kinds := map[string]bool{}
	ids := map[string]bool{}
	for _, p := range periodicJobs(config.Load()) {
		kind := p.Args.Kind()
		if !strings.HasPrefix(kind, "podhub.") {
			t.Fatalf("kind %q lacks the podhub. prefix", kind)
		}
		if kinds[kind] || ids[p.ID] || p.ID == "" {
			t.Fatalf("duplicate or empty entry %q %q", kind, p.ID)
		}
		if p.Interval <= 0 {
			t.Fatalf("%s interval %s", kind, p.Interval)
		}
		kinds[kind], ids[p.ID] = true, true
	}

	workers := river.NewWorkers()
	for _, addon := range riverAddons(nil, config.Load()) {
		addon.Register(workers)
	}
	probes := map[string]error{
		telemetryjobs.DigestArgs{}.Kind(): river.AddWorkerSafely(workers, &telemetryjobs.DigestWorker{}),
		ratingjobs.SyncArgs{}.Kind():      river.AddWorkerSafely(workers, &ratingjobs.SyncWorker{}),
		ratingjobs.PruneArgs{}.Kind():     river.AddWorkerSafely(workers, &ratingjobs.PruneWorker{}),
	}
	if len(probes) != len(kinds) {
		t.Fatalf("probes cover %d kinds, table has %d", len(probes), len(kinds))
	}
	for kind, err := range probes {
		if !kinds[kind] || err == nil {
			t.Fatalf("%s: in table %v, second worker accepted %v", kind, kinds[kind], err == nil)
		}
	}
}
