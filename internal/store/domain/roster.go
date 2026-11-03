package domain

import (
	"encoding/json"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// Status is WorkspaceStoreStatus: the display projection where a manual
// disable wins over a quota suspension.
type Status string

const (
	// StatusActive is a store that may send.
	StatusActive Status = "active"
	// StatusManualDisabled is a manager's switch.
	StatusManualDisabled Status = "manual_disabled"
	// StatusQuotaSuspended is the Workspace store quota cutting the store off.
	StatusQuotaSuspended Status = "quota_suspended"
)

// The quota reconcile actions. Rust serialises these SCREAMING_SNAKE.
const (
	ActionSuspend = "SUSPEND"
	ActionRestore = "RESTORE"
)

// TagRef is the {uuid,name} pair tags and groups share on the wire.
type TagRef struct {
	UUID string
	Name string
}

// Assignee is the one Membership that runs a Store.
type Assignee struct {
	MembershipID int64
	Name         string
	Email        string
}

// Permissions is the effective rights of one actor over one Store.
type Permissions struct {
	ManageStore bool
	EditName    bool
	TestKey     bool
	ManageKey   bool
	DeleteStore bool
	ManageTags  bool
}

// Row is one organization_stores projection: every non-secret fact the roster,
// the mutation path, and the products surfaces read. Credential secrets are
// absent by construction; only whether ciphertext exists is carried.
type Row struct {
	ID                          int64
	UUID                        string
	CreateOrder                 int64
	Name                        string
	ClientID                    *string
	ManualDisabled              bool
	QuotaSuspended              bool
	CredentialRevision          int64
	CredentialConfigured        bool
	CredentialAnyConfigured     bool
	CredentialVerifiedOperators int64
	CredentialLastVerifiedAtMS  *int64
	CredentialLastUsedAtMS      *int64
	CredentialKeyExpiresAtMS    *int64
	AssigneeMembershipID        *int64
	AssigneeName                *string
	AssigneeEmail               *string
	ProductQuota                json.RawMessage
	FinanceBalance              json.RawMessage
	CompanyCurrency             string
	Revision                    int64
	DeletedAtMS                 *int64
	Tags                        []TagRef
	Group                       *TagRef
}

// Actor is the caller's membership inside the Workspace.
type Actor struct {
	MembershipID int64
	UserID       int64
	Role         string
}

// CanManageAll is StoreActor::can_manage_all: owner or manager.
func (a Actor) CanManageAll() bool { return access.CanManage(a.Role) }

// IsOwner reports the stored owner role.
func (a Actor) IsOwner() bool {
	role, ok := access.ParseWorkspace(a.Role)
	return ok && role == "owner"
}

// IsAssigneeOf reports whether this actor holds the given assignee seat.
func (a Actor) IsAssigneeOf(assigneeMembershipID *int64) bool {
	return assigneeMembershipID != nil && *assigneeMembershipID == a.MembershipID
}

// Visible is is_store_visible_to_operator. A manager sees every store; anyone
// else sees only the store assigned to them, so an unassigned store is
// invisible to a member.
func (a Actor) Visible(assigneeMembershipID *int64) bool {
	return access.StoreVisible(a.Role, assigneeMembershipID, a.MembershipID)
}

// Status is store_status: manual disable takes precedence.
func (r Row) Status() Status {
	if r.ManualDisabled {
		return StatusManualDisabled
	}
	if r.QuotaSuspended {
		return StatusQuotaSuspended
	}
	return StatusActive
}

// Live reports whether the store may send: neither switch is thrown.
func (r Row) Live() bool { return !r.ManualDisabled && !r.QuotaSuspended }

// Permissions is store_view's permission block for one actor.
//
// test_key needs a live store with ciphertext for the current generation and an
// unexpired key: egress refuses an expired generation, so offering a test that
// cannot succeed would be a lie.
func (r Row) Permissions(a Actor, nowMS int64) Permissions {
	visible := a.Visible(r.AssigneeMembershipID)
	manageKey := a.CanManageAll()
	expired := r.CredentialKeyExpiresAtMS != nil && *r.CredentialKeyExpiresAtMS <= nowMS
	manageAll := a.CanManageAll()
	deleteStore := manageAll || a.IsAssigneeOf(r.AssigneeMembershipID)
	if r.CredentialAnyConfigured {
		deleteStore = manageKey
	}
	return Permissions{
		ManageStore: manageAll,
		EditName:    visible,
		TestKey:     visible && r.CredentialConfigured && r.Live() && !expired,
		ManageKey:   manageKey,
		DeleteStore: deleteStore,
		ManageTags:  visible,
	}
}

// Assignee returns the embedded assignee, or nil when the store is unassigned.
func (r Row) Assignee() *Assignee {
	if r.AssigneeMembershipID == nil {
		return nil
	}
	out := Assignee{MembershipID: *r.AssigneeMembershipID}
	if r.AssigneeName != nil {
		out.Name = *r.AssigneeName
	}
	if r.AssigneeEmail != nil {
		out.Email = *r.AssigneeEmail
	}
	return &out
}

// ProductQuotaView decodes the stored Ozon product-upload quota. A value the
// typed shape cannot hold is dropped, matching the Rust `from_value(...).ok()`.
func (r Row) ProductQuotaView() *ProductQuota {
	return decodeProductQuota(r.ProductQuota)
}

// FinanceBalanceView decodes the stored Finance → Balance snapshot, dropping a
// value the typed shape cannot hold.
func (r Row) FinanceBalanceView() *FinanceBalance {
	return decodeFinanceBalance(r.FinanceBalance)
}

// QuotaChange is one store transition a quota reconcile produced.
type QuotaChange struct {
	UUID        string
	CreateOrder int64
	Action      string
}

// QuotaChanges is the suspend/restore pair a write reports.
type QuotaChanges struct {
	Suspend []QuotaChange
	Restore []QuotaChange
}

// Ensure makes both halves non-nil so the wire renders [] instead of null.
func (q QuotaChanges) Ensure() QuotaChanges {
	if q.Suspend == nil {
		q.Suspend = []QuotaChange{}
	}
	if q.Restore == nil {
		q.Restore = []QuotaChange{}
	}
	return q
}

// Tombstone is a deleted Store retained so a long-offline desktop can learn
// about a remote deletion on its next sync.
type Tombstone struct {
	UUID        string
	DeletedAtMS int64
	Revision    int64
}

// Roster is one Workspace's store roster.
type Roster struct {
	Stores               []Row
	Tags                 []TagView
	Groups               []TagView
	StoreLimit           int64
	StoresUsed           int64
	Suspended            int64
	QuotaRevision        *int64
	QuotaSuspendedStores []QuotaChange
	Tombstones           []Tombstone
}

// TagView is WorkspaceStoreTagView: a tag or a group with its live store count.
type TagView struct {
	UUID       string
	Name       string
	StoreCount int64
}

// ProductQuota is the last successful Ozon product-upload quota snapshot.
// Like FinanceBalance, the stored jsonb is served to the SPA as-is, so the
// keys are the WorkspaceStoreProductQuota contract (snake_case). A row stored
// under the old camelCase spelling decodes with FetchedAtMS 0, which the
// refresh loop treats as stale and overwrites.
type ProductQuota struct {
	FetchedAtMS int64               `json:"fetched_at_ms"`
	Total       *ProductQuotaTotal  `json:"total,omitempty"`
	DailyCreate *ProductQuotaBucket `json:"daily_create,omitempty"`
	DailyUpdate *ProductQuotaBucket `json:"daily_update,omitempty"`
}

// ProductQuotaBucket is one Ozon upload bucket. Limit -1 means no cap.
type ProductQuotaBucket struct {
	Limit int64 `json:"limit"`
	Usage int64 `json:"usage"`
}

// ProductQuotaTotal is the base limit plus in-demand category quotas.
type ProductQuotaTotal struct {
	Limit      int64                   `json:"limit"`
	Usage      int64                   `json:"usage"`
	Archived   *int64                  `json:"archived,omitempty"`
	Categories *[]ProductQuotaCategory `json:"categories,omitempty"`
}

// ProductQuotaCategory is one in-demand category's extra quota.
type ProductQuotaCategory struct {
	CategoryID int64 `json:"category_id"`
	Limit      int64 `json:"limit"`
	Usage      int64 `json:"usage"`
}

// FinanceBalance is the last Seller Finance → Balance snapshot for a Store.
// The JSON keys are the wire contract (WorkspaceStoreFinanceBalance): the
// stored jsonb is served to the SPA as-is, so they are snake_case. A row
// written under any other spelling decodes with FetchedAtMS 0, which the
// refresh loop treats as stale and overwrites.
type FinanceBalance struct {
	Amount       *string `json:"amount,omitempty"`
	CurrencyCode *string `json:"currency_code,omitempty"`
	FetchedAtMS  int64   `json:"fetched_at_ms"`
	Outcome      string  `json:"outcome"`
	PeriodTo     string  `json:"period_to"`
	FxAsOf       *string `json:"fx_as_of,omitempty"`
	FxQuote      *string `json:"fx_quote,omitempty"`
	FxRate       *string `json:"fx_rate,omitempty"`
	FxSource     *string `json:"fx_source,omitempty"`
}

func decodeProductQuota(raw json.RawMessage) *ProductQuota {
	if len(raw) == 0 {
		return nil
	}
	var out ProductQuota
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return &out
}

func decodeFinanceBalance(raw json.RawMessage) *FinanceBalance {
	if len(raw) == 0 {
		return nil
	}
	var out FinanceBalance
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return &out
}

// NowMS is the millisecond clock the roster and permission rules compare with.
func NowMS() int64 { return time.Now().UnixMilli() }
