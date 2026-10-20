// Package queue only links the jobs kernel at init: service and
// platform/jobsched get the repo functions they may not import. The names
// live under contract, domain, repo, service, and jobs. A binary that runs the
// claim loop or calls jobsched must import this package, blank if needed.
package queue

import (
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"github.com/xxww0098/podhub-go/internal/queue/service"
)

// init connects the claim loop to the repo functions. service does not import repo.
func init() {
	service.Claim = queuerepo.Claim
	service.FormatOwner = queuerepo.FormatOwner
	service.ReclaimExpiredRows = queuerepo.ReclaimExpiredRows
	service.RunningOwned = queuerepo.RunningOwned
	service.RequeueJob = queuerepo.RequeueJob
	service.Settle = queuerepo.Settle
	service.StateSucceeded = queuerepo.StateSucceeded
}
