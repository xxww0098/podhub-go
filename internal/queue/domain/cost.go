package domain

import "github.com/xxww0098/podhub-go/internal/queue/contract"

// CostUnits matches jobs/mod.rs cost_units_for_kind.
func CostUnits(kind string) int32 { return contract.CostUnits(kind) }
