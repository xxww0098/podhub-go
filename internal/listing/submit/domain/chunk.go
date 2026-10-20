package domain

import "github.com/google/uuid"

// ImportDispatchChunk is one /v3/product/import and one listing.submit.batch
// job. Source: import_dispatch.rs IMPORT_DISPATCH_CHUNK.
const ImportDispatchChunk = 20

// ImportV3MaxItems is the user-facing cap named next to that chunk.
const ImportV3MaxItems = 100

// JobPlan is one chunk. The first chunk keeps the caller's ids so a replay
// still collides on (org_id, kind, idempotency_key). Later chunks mint ids.
// Their idempotency key is `{batchID}:{index}`.
type JobPlan struct {
	JobID          string
	BatchID        string
	IdempotencyKey string
	Intents        []int
}

func PlanImportJobs(callerJobID, callerBatchID string, n int) []JobPlan {
	if n <= 0 {
		return nil
	}
	var plans []JobPlan
	for index, start := 0, 0; start < n; index, start = index+1, start+ImportDispatchChunk {
		end := start + ImportDispatchChunk
		if end > n {
			end = n
		}
		ids := make([]int, 0, end-start)
		for i := start; i < end; i++ {
			ids = append(ids, i)
		}
		plan := JobPlan{Intents: ids}
		if index == 0 {
			plan.JobID = callerJobID
			plan.BatchID = callerBatchID
			plan.IdempotencyKey = callerBatchID
		} else {
			id := uuid.NewString()
			plan.JobID = id
			plan.BatchID = id
			plan.IdempotencyKey = callerBatchID + ":" + itoa(index)
		}
		plans = append(plans, plan)
	}
	return plans
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
