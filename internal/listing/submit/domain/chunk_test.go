package domain

import "testing"

func TestFirstChunkKeepsCallerIDs(t *testing.T) {
	plans := PlanImportJobs("job", "batch", ImportV3MaxItems)
	if len(plans) != 1 || plans[0].JobID != "job" || plans[0].BatchID != "batch" || plans[0].IdempotencyKey != "batch" || len(plans[0].Intents) != ImportV3MaxItems {
		t.Fatalf("%+v", plans)
	}
}

func TestOneHundredOneBecomesTwoJobs(t *testing.T) {
	plans := PlanImportJobs("job", "batch", ImportV3MaxItems+1)
	if len(plans) != 2 {
		t.Fatalf("%d", len(plans))
	}
	if plans[0].IdempotencyKey != "batch" || plans[1].IdempotencyKey != "batch:1" {
		t.Fatalf("%+v", plans)
	}
	if len(plans[0].Intents) != ImportV3MaxItems || len(plans[1].Intents) != 1 {
		t.Fatalf("chunk sizes %d %d", len(plans[0].Intents), len(plans[1].Intents))
	}
	if plans[1].JobID == plans[0].JobID || plans[1].JobID != plans[1].BatchID {
		t.Fatalf("%+v", plans[1])
	}
	total := 0
	for _, plan := range plans {
		total += len(plan.Intents)
	}
	if total != ImportV3MaxItems+1 {
		t.Fatal(total)
	}
}

func TestEmptyEnqueuePlansNothing(t *testing.T) {
	if PlanImportJobs("job", "batch", 0) != nil {
		t.Fatal("empty")
	}
}
