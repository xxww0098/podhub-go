package service

import "testing"

func TestMembershipDirectoryStatus(t *testing.T) {
	for _, tc := range []struct {
		status              string
		disabled, suspended bool
		want                string
	}{
		{"active", false, false, "active"},
		{"active", false, true, "quota_suspended"},
		{"active", true, true, "manual_disabled"},
		{"inactive", false, false, "manual_disabled"},
	} {
		if got := MembershipDirectoryStatus(tc.status, tc.disabled, tc.suspended); got != tc.want {
			t.Fatalf("%+v: %s", tc, got)
		}
	}
}
