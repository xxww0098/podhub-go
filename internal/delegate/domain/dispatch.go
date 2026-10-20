package domain

import "github.com/xxww0098/podhub-go/internal/delegate/contract"

// Dispatch actions implemented by public.delegate_supplier_accept,
// delegate_supplier_reject and delegate_supplier_ship
// (db/migrations/00259_delegate_action_locks.sql).
const (
	ActionAccept = "accept"
	ActionReject = "reject"
	ActionShip   = "ship"
)

// ApplyDispatch is the control flow of those three functions after the row
// locks. found is the dispatch row. An empty orderState is the order row
// missing under the lock. member is an active sc_source_members row.
// Accept of an already accepted packet returns accepted and does not write.
// Reject and ship are not idempotent.
func ApplyDispatch(action, dispatchState, orderState string, member, found bool) (string, error) {
	if !found {
		return "", contract.ErrNotFound
	}
	if !member {
		return "", contract.ErrForbidden
	}
	if orderState == "" {
		return "", contract.ErrNotFound
	}
	terminalOrder := orderState == "cancelled" || orderState == "done"
	switch action {
	case ActionAccept:
		if terminalOrder {
			return "", contract.ErrTerminal
		}
		if dispatchState == "accepted" {
			return "accepted", nil
		}
		if dispatchState != "dispatched" {
			return "", contract.ErrTerminal
		}
		return "accepted", nil
	case ActionReject:
		if terminalOrder || dispatchState != "dispatched" {
			return "", contract.ErrTerminal
		}
		return "rejected", nil
	case ActionShip:
		if terminalOrder || dispatchState != "accepted" {
			return "", contract.ErrTerminal
		}
		return "shipped", nil
	default:
		return "", contract.ErrUnknownAction
	}
}
