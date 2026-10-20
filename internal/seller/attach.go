package seller

import (
	"github.com/jackc/pgx/v5/pgxpool"

	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

// Attach wires UnknownImportsScan to submit.ProbeDue. The function body
// lives in internal/app/worker. That package assigns this variable from init,
// which runs for every process that imports internal/app.
var Attach func(scans []queue.DueScan, pool *pgxpool.Pool, eg *Egress)
