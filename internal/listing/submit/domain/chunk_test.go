package domain

import "testing"

func TestFirstChunkKeepsCallerIDs(t *testing.T) {
	plans := PlanImportJobs("job", "batch", 20)
	if len(plans) != 1 || plans[0].JobID != "job" || plans[0].BatchID != "batch" || plans[0].IdempotencyKey != "batch" || len(plans[0].Intents) != 20 {
		t.Fatalf("%+v", plans)
	}
}

func TestSeventyFiveBecomesFourJobs(t *testing.T) {
	plans := PlanImportJobs("job", "batch", 75)
	if len(plans) != 4 {
		t.Fatalf("%d", len(plans))
	}
	if plans[0].IdempotencyKey != "batch" || plans[1].IdempotencyKey != "batch:1" || plans[2].IdempotencyKey != "batch:2" || plans[3].IdempotencyKey != "batch:3" {
		t.Fatalf("%+v", plans)
	}
	if len(plans[3].Intents) != 15 {
		t.Fatal(len(plans[3].Intents))
	}
	if plans[1].JobID == plans[0].JobID || plans[1].JobID != plans[1].BatchID {
		t.Fatalf("%+v", plans[1])
	}
	total := 0
	for _, plan := range plans {
		total += len(plan.Intents)
	}
	if total != 75 {
		t.Fatal(total)
	}
}

func TestEmptyEnqueuePlansNothing(t *testing.T) {
	if PlanImportJobs("job", "batch", 0) != nil {
		t.Fatal("empty")
	}
}
