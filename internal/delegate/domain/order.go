package domain

import "github.com/xxww0098/podhub-go/internal/delegate/contract"

// Line is one delegate_order_lines row as
// delegate_supplier_recompute_order_state reads it
// (db/migrations/00205_supplier_portal_actions.sql).
// Ready is the SELECT boolean `(b.active IS TRUE AND EXISTS verified asset)`.
// A missing binding makes `b.active IS TRUE` false, so Ready nil and Ready
// false both clear all_ready. That expression never yields SQL NULL.
// Packet is the latest dispatch state whose payload contains the line,
// or "" when that subquery finds nothing.
type Line struct {
	Ready  *bool
	Packet string
}

// ComputeOrderState is the value the function returns.
func ComputeOrderState(lines []Line) string {
	if len(lines) == 0 {
		return "awaiting_setup"
	}
	allShipped := true
	anyAccepted := false
	anyLive := false
	allReady := true
	for _, line := range lines {
		switch line.Packet {
		case "shipped":
			anyLive = true
			anyAccepted = true
		case "accepted":
			anyLive = true
			anyAccepted = true
			allShipped = false
		case "dispatched":
			anyLive = true
			allShipped = false
		default:
			allShipped = false
		}
		if line.Ready == nil || !*line.Ready {
			allReady = false
		}
	}
	switch {
	case allShipped:
		return "shipped"
	case anyAccepted:
		return "in_production"
	case anyLive:
		return "dispatched"
	case allReady:
		return "ready"
	default:
		return "awaiting_setup"
	}
}

// StoredOrderState is the column after the function's UPDATE.
// done and cancelled are left unchanged.
func StoredOrderState(current string, lines []Line) string {
	if current == "done" || current == "cancelled" {
		return current
	}
	return ComputeOrderState(lines)
}

// TransitionOrder refuses seller cancel, close and nudge. Those statements
// are not in the copied SQL functions.
func TransitionOrder(from, to string) error {
	return contract.ErrUnproven
}
