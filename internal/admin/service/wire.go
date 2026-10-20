package service

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

type okData struct {
	OK bool `json:"ok"`
}
type okEnvelope struct {
	Data okData `json:"data"`
}

func okBody() okEnvelope { return okEnvelope{Data: okData{OK: true}} }

type accountUser struct {
	Kind          string `json:"kind"`
	RoleLabel     string `json:"role_label"`
	UUID          string `json:"uuid"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	IsAdmin       bool   `json:"is_admin"`
	Plan          string `json:"plan"`
	SeatLimit     int64  `json:"seat_limit"`
	SeatsUsed     int64  `json:"seats_used"`
	TokensUsed    int64  `json:"ai_tokens_used"`
	TokensMonthly int64  `json:"ai_tokens_monthly"`
	CreatedAt     string `json:"created_at"`
	Status        string `json:"status"`
	Disabled      bool   `json:"disabled"`
	Manageable    bool   `json:"manageable"`
	Editable      bool   `json:"editable"`
}

type mutationEnvelope struct {
	Data struct {
		OK   bool        `json:"ok"`
		User accountUser `json:"user"`
	} `json:"data"`
}

func mutationBody(actor domain.Actor, a domain.Account) mutationEnvelope {
	var out mutationEnvelope
	out.Data.OK = true
	out.Data.User = accountUserFrom(actor, a)
	return out
}

func accountUserFrom(actor domain.Actor, a domain.Account) accountUser {
	manageable := a.ID != actor.ID && domain.CanMutate(actor.Role, a.Role)
	seat, used, tokens, monthly := a.SeatLimit, a.SeatsUsed, a.TokensUsed, a.TokensMonthly
	if a.OrgID == nil {
		seat, used, tokens, monthly = 0, 0, 0, 0
	}
	return accountUser{
		Kind: domain.RankFromStored(a.Role), RoleLabel: domain.RankLabel(a.Role),
		UUID: a.PublicID, Email: a.Email, Name: a.Name, Role: domain.RankFromStored(a.Role),
		IsAdmin: domain.Staff(a.Role), Plan: domain.PlanInEffect(a.OrgPlan, a.Plan),
		SeatLimit: seat, SeatsUsed: used, TokensUsed: tokens, TokensMonthly: monthly,
		CreatedAt: a.CreatedAt, Status: domain.AccountStatus(a.Disabled), Disabled: a.Disabled,
		Manageable: manageable, Editable: manageable || a.ID == actor.ID,
	}
}

type personView struct {
	Kind             string  `json:"kind"`
	RoleLabel        string  `json:"role_label"`
	UUID             string  `json:"uuid"`
	Email            string  `json:"email"`
	Name             string  `json:"name"`
	Role             string  `json:"role"`
	IsAdmin          bool    `json:"is_admin"`
	CreatedAt        string  `json:"created_at"`
	LastLogin        string  `json:"last_login_at"`
	Status           string  `json:"status"`
	Disabled         bool    `json:"disabled"`
	Manageable       bool    `json:"manageable"`
	Editable         bool    `json:"editable"`
	MembershipRole   *string `json:"membership_role,omitempty"`
	MembershipStatus *string `json:"membership_status,omitempty"`
}

func personFrom(actor domain.Actor, p domain.Person) personView {
	manageable := p.UserID != actor.ID && domain.CanMutate(actor.Role, p.Role)
	view := personView{
		Kind: domain.RankFromStored(p.Role), RoleLabel: domain.RankLabel(p.Role),
		UUID: p.PublicID, Email: p.Email, Name: p.Name, Role: domain.RankFromStored(p.Role),
		IsAdmin: domain.Staff(p.Role), CreatedAt: p.CreatedAt, LastLogin: p.LastLogin,
		Status: domain.AccountStatus(p.Disabled), Disabled: p.Disabled,
		Manageable: manageable, Editable: manageable || p.UserID == actor.ID,
	}
	if p.HasMembership {
		role := p.MembershipRole
		status := domain.MembershipStatus(p.Manual, p.Quota)
		view.MembershipRole = &role
		view.MembershipStatus = &status
	}
	return view
}

type workspaceView struct {
	ID         int64        `json:"id"`
	UUID       string       `json:"uuid"`
	Name       string       `json:"name"`
	Plan       string       `json:"plan"`
	SeatLimit  int64        `json:"seat_limit"`
	SeatsUsed  int64        `json:"seats_used"`
	TokensUsed int64        `json:"ai_tokens_used"`
	TokensMon  int64        `json:"ai_tokens_monthly"`
	Available  int64        `json:"wallet_available_microfen"`
	Held       int64        `json:"wallet_held_microfen"`
	CreatedAt  string       `json:"created_at"`
	OwnerUUID  string       `json:"owner_uuid"`
	Members    []personView `json:"members"`
}

func directoryBody(actor domain.Actor, dir domain.Directory) any {
	spaces := make([]workspaceView, 0, len(dir.Workspaces))
	for _, w := range dir.Workspaces {
		members := make([]personView, 0, len(w.Members))
		for _, m := range w.Members {
			members = append(members, personFrom(actor, m))
		}
		spaces = append(spaces, workspaceView{
			ID: w.ID, UUID: w.UUID, Name: w.Name, Plan: w.Plan, SeatLimit: w.SeatLimit,
			SeatsUsed: w.SeatsUsed, TokensUsed: w.TokensUsed, TokensMon: w.TokensMonthly,
			Available: w.Available, Held: w.Held, CreatedAt: w.CreatedAt, OwnerUUID: w.OwnerUUID,
			Members: members,
		})
	}
	free := make([]personView, 0, len(dir.Unaffiliated))
	for _, p := range dir.Unaffiliated {
		free = append(free, personFrom(actor, p))
	}
	return struct {
		Data struct {
			Workspaces     []workspaceView `json:"workspaces"`
			Unaffiliated   []personView    `json:"unaffiliated"`
			WorkspaceCount int             `json:"workspace_count"`
			UserCount      int             `json:"user_count"`
		} `json:"data"`
	}{Data: struct {
		Workspaces     []workspaceView `json:"workspaces"`
		Unaffiliated   []personView    `json:"unaffiliated"`
		WorkspaceCount int             `json:"workspace_count"`
		UserCount      int             `json:"user_count"`
	}{spaces, free, len(spaces), dir.UserCount}}
}

type quotaView struct {
	Default       int64  `json:"default"`
	OverrideValue *int64 `json:"overrideValue,omitempty"`
	Effective     int64  `json:"effective"`
	Used          int64  `json:"used"`
	Suspended     int64  `json:"suspended"`
}

type memberChange struct {
	MembershipID int64  `json:"membership_id"`
	UserID       int64  `json:"user_id"`
	JoinOrder    int64  `json:"join_order"`
	Action       string `json:"action"`
}

type storeChange struct {
	UUID        string `json:"uuid"`
	CreateOrder int64  `json:"createOrder"`
	Action      string `json:"action"`
}

func changes(in []domain.MemberChange) []memberChange {
	out := make([]memberChange, 0, len(in))
	for _, c := range in {
		out = append(out, memberChange{c.MembershipID, c.UserID, c.JoinOrder, c.Action})
	}
	return out
}

func storeChanges(in []domain.StoreChange) []storeChange {
	out := make([]storeChange, 0, len(in))
	for _, c := range in {
		out = append(out, storeChange{c.UUID, c.CreateOrder, c.Action})
	}
	return out
}

func quota(defaultSeats, effective, used, suspended int64, override *int64, follow bool) quotaView {
	view := quotaView{Default: defaultSeats, Effective: effective, Used: used, Suspended: suspended}
	if !follow {
		view.OverrideValue = override
	}
	return view
}

func previewBody(state domain.SeatState, target domain.SeatTarget, members domain.MemberPlan, stores domain.StorePlan) any {
	type data struct {
		Revision     int64          `json:"revision"`
		Plan         string         `json:"plan"`
		MemberSeats  quotaView      `json:"memberSeats"`
		Suspend      []memberChange `json:"suspend"`
		Restore      []memberChange `json:"restore"`
		StoreSlots   quotaView      `json:"storeSlots"`
		StoreSuspend []storeChange  `json:"storeSuspend,omitempty"`
		StoreRestore []storeChange  `json:"storeRestore,omitempty"`
	}
	body := data{
		Revision: state.Revision, Plan: target.Plan,
		MemberSeats: quota(target.Purchased, target.SeatLimit, members.Used, members.Suspended, target.MemberOverride, target.FollowMembers),
		Suspend:     changes(members.Suspend), Restore: changes(members.Restore),
		StoreSlots: quota(target.PlanDefaultStores, target.StoreLimit, stores.Used, stores.Suspended, target.StoreOverride, target.FollowStores),
	}
	if len(stores.Suspend) > 0 {
		body.StoreSuspend = storeChanges(stores.Suspend)
	}
	if len(stores.Restore) > 0 {
		body.StoreRestore = storeChanges(stores.Restore)
	}
	return struct {
		Data data `json:"data"`
	}{body}
}

func applyBody(target domain.SeatTarget, members domain.MemberPlan, stores domain.StorePlan, revision int64) any {
	type data struct {
		OK           bool           `json:"ok"`
		Revision     int64          `json:"revision"`
		Plan         string         `json:"plan"`
		MemberSeats  quotaView      `json:"memberSeats"`
		Suspend      []memberChange `json:"suspend"`
		Restore      []memberChange `json:"restore"`
		StoreSlots   quotaView      `json:"storeSlots"`
		StoreSuspend []storeChange  `json:"storeSuspend,omitempty"`
		StoreRestore []storeChange  `json:"storeRestore,omitempty"`
	}
	body := data{
		OK: true, Revision: revision, Plan: target.Plan,
		MemberSeats: quota(target.Purchased, target.SeatLimit, members.Used, members.Suspended, target.MemberOverride, target.FollowMembers),
		Suspend:     changes(members.Suspend), Restore: changes(members.Restore),
		StoreSlots: quota(target.PlanDefaultStores, target.StoreLimit, stores.Used, stores.Suspended, target.StoreOverride, target.FollowStores),
	}
	if len(stores.Suspend) > 0 {
		body.StoreSuspend = storeChanges(stores.Suspend)
	}
	if len(stores.Restore) > 0 {
		body.StoreRestore = storeChanges(stores.Restore)
	}
	return struct {
		Data data `json:"data"`
	}{body}
}

func rfc3339Millis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
