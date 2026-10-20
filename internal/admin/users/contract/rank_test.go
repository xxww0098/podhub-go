package contract

import "testing"

func TestAuthorizeNamedEdges(t *testing.T) {
	cases := []struct {
		name   string
		actor  string
		kind   string
		role   string
		target string
		last   bool
		ok     bool
		msg    string
	}{
		{"super creates user", RankSuper, "create", RankUser, RankUser, false, true, ""},
		{"super creates admin", RankSuper, "create", RankAdmin, RankUser, false, true, ""},
		{"super creates super", RankSuper, "create", RankSuper, RankUser, false, false, msgCannotAssign},
		{"admin creates user", RankAdmin, "create", RankUser, RankUser, false, true, ""},
		{"admin creates admin", RankAdmin, "create", RankAdmin, RankUser, false, false, msgCannotAssign},
		{"user creates user", RankUser, "create", RankUser, RankUser, false, false, msgCannotAssign},
		{"super assigns admin", RankSuper, "assign", RankAdmin, RankUser, false, true, ""},
		{"super assigns super", RankSuper, "assign", RankSuper, RankUser, false, false, msgCannotAssign},
		{"admin assigns staff", RankAdmin, "assign", RankAdmin, RankUser, false, false, msgCannotAssign},
		{"admin mutates staff", RankAdmin, "assign", RankUser, RankAdmin, false, false, msgCannotMutate},
		{"user mutates user", RankUser, "edit", "", RankUser, false, false, msgCannotMutate},
		{"super edits self", RankSuper, "edit", "", RankSuper, true, true, ""},
		{"super disables other admin", RankSuper, "disable", "", RankAdmin, false, true, ""},
		{"last super disable", RankSuper, "disable", "", RankSuper, true, false, msgLastSuper},
		{"not last super disable", RankSuper, "disable", "", RankSuper, false, true, ""},
		{"last super demote", RankSuper, "assign", RankAdmin, RankSuper, true, false, msgLastSuper},
		{"last super stay", RankSuper, "assign", RankSuper, RankSuper, true, false, msgCannotAssign},
		{"enable is edit", RankSuper, "edit", "", RankSuper, true, true, ""},
		{"blank rank is user", RankSuper, "edit", "", " ", false, true, ""},
		{"unknown kind", RankSuper, "nope", "", RankUser, false, false, msgCannotMutate},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg, ok := Authorize(tc.actor, Change{Kind: tc.kind, Role: tc.role}, tc.target, tc.last)
			if ok != tc.ok || msg != tc.msg {
				t.Fatalf("got ok=%v %q want ok=%v %q", ok, msg, tc.ok, tc.msg)
			}
		})
	}
}
