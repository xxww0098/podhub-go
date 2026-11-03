package service

// MembershipDirectoryStatus projects a roster row.
// manual_disabled wins over quota_suspended.
func MembershipDirectoryStatus(status string, manualDisabled, quotaSuspended bool) string {
	if status != "active" || manualDisabled {
		return "manual_disabled"
	}
	if quotaSuspended {
		return "quota_suspended"
	}
	return "active"
}

// PendingInviteLimit is how many invitations may wait for an answer at once.
// It no longer follows the member limit: every workspace has the same cap of
// 10 members, so the same cap of 10 pending invitations.
const PendingInviteLimit int64 = 10
