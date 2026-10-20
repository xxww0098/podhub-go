package contract

import "github.com/xxww0098/podhub-go/internal/platform/jobsched"

// CostUnits matches jobs/mod.rs cost_units_for_kind.
func CostUnits(kind string) int32 { return jobsched.CostUnits(kind) }
