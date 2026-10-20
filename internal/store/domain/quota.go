package domain

import (
	"sort"
	"strings"
)

// The store-quota planner constants. Limit below 1 is floored at 1; a
// manually disabled store never takes a slot and is never auto-restored.
const (
	// MinStoreLimit is the floor of the effective Store limit.
	MinStoreLimit = 1
	// FreeStores is the lite plan's Store pool.
	FreeStores = 1
	// StoresPerSeat is the Store pool multiplier for paid plans.
	StoresPerSeat = 5
	// MaxStores is the ceiling of the effective Store limit.
	MaxStores = 100
)

// ReconcileRow is one non-deleted Store the quota planner considers.
type ReconcileRow struct {
	ID             int64
	UUID           string
	CreateOrder    int64
	ManualDisabled bool
	QuotaSuspended bool
	// LastUsedMS is the Seller credential's last lease; nil means never used.
	LastUsedMS *int64
}

// ReconcilePlan is the pure Store-quota decision: which stores to suspend,
// which to restore, and what the result projects to.
type ReconcilePlan struct {
	Suspend       []QuotaChange
	Restore       []QuotaChange
	ProjectedUsed int64
	Suspended     int64
}

// StoreQuotaFor is store_quota_for: the plan default before any override.
func StoreQuotaFor(tier string, seats int64) int64 {
	if strings.ToLower(strings.TrimSpace(tier)) == "lite" {
		return FreeStores
	}
	n := seats
	if n < 1 {
		n = 1
	}
	n *= StoresPerSeat
	if n > MaxStores {
		return MaxStores
	}
	return n
}

// PlanStoreQuotaReconcile is plan_store_quota_reconcile. Recently used stores
// keep the live slots; the longest idle (or never used) suspend first, and
// create_order only breaks ties.
func PlanStoreQuotaReconcile(stores []ReconcileRow, limit int64) ReconcilePlan {
	if limit < MinStoreLimit {
		limit = MinStoreLimit
	}
	ordered := append([]ReconcileRow(nil), stores...)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.Used() != b.Used() {
			return b.Used() < a.Used()
		}
		if a.CreateOrder != b.CreateOrder {
			return a.CreateOrder < b.CreateOrder
		}
		return a.ID < b.ID
	})
	var plan ReconcilePlan
	var used int64
	for _, row := range ordered {
		// A manually disabled store neither consumes capacity nor gets
		// auto-restored. An already-suspended flag stays until the store is
		// manually enabled again.
		if row.ManualDisabled {
			if row.QuotaSuspended {
				plan.Suspended++
			}
			continue
		}
		target := used < limit
		if target {
			used++
		} else {
			plan.Suspended++
		}
		switch {
		case !row.QuotaSuspended && !target:
			plan.Suspend = append(plan.Suspend, QuotaChange{
				UUID: row.UUID, CreateOrder: row.CreateOrder, Action: ActionSuspend,
			})
		case row.QuotaSuspended && target:
			plan.Restore = append(plan.Restore, QuotaChange{
				UUID: row.UUID, CreateOrder: row.CreateOrder, Action: ActionRestore,
			})
		}
	}
	// The selection scan keeps keepers first. Present the suspends in the order
	// an operator reads them — never used, then longest idle — without changing
	// which stores hold the available slots.
	index := make(map[string]ReconcileRow, len(stores))
	for _, row := range stores {
		index[row.UUID] = row
	}
	sort.SliceStable(plan.Suspend, func(i, j int) bool {
		a, b := index[plan.Suspend[i].UUID], index[plan.Suspend[j].UUID]
		if a.Used() != b.Used() {
			return a.Used() < b.Used()
		}
		if a.CreateOrder != b.CreateOrder {
			return a.CreateOrder < b.CreateOrder
		}
		return a.ID < b.ID
	})
	return plan
}

// Used is the credential's last lease, or 0 when the store never used one.
func (r ReconcileRow) Used() int64 {
	if r.LastUsedMS == nil {
		return 0
	}
	return *r.LastUsedMS
}
