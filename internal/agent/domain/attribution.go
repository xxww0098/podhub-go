package domain

import "github.com/xxww0098/podhub-go/internal/agent/contract"

// Attribute matches the attribution CHECKs and the write-once trigger.
// current is the stored invited_by_agent_user_id. source may be empty: the
// CHECK allows NULL. A non-empty source must be register or claim.
// bps nil is the nullable column; a value must sit in 0..10000.
func Attribute(userID int64, current *int64, agentUserID int64, source string, bps *int) error {
	if userID <= 0 || agentUserID <= 0 {
		return contract.ErrInvalidShape
	}
	if userID == agentUserID {
		return contract.ErrSelfInvite
	}
	if current != nil && *current != agentUserID {
		return contract.ErrWriteOnce
	}
	switch source {
	case "", "register", "claim":
	default:
		return contract.ErrInvalidShape
	}
	if bps != nil {
		if err := RebateBps(*bps); err != nil {
			return err
		}
	}
	return nil
}
