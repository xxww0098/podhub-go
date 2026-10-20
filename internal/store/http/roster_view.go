package storehttp

import (
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The wire shapes. Optional fields are pointers so an absent value is omitted
// rather than rendered as zero: `never synced` and `0 items` must not look the
// same to the SPA.
type storeView struct {
	UUID                        string                 `json:"uuid"`
	CreateOrder                 int64                  `json:"create_order"`
	Name                        string                 `json:"name"`
	Tags                        []tagRefView           `json:"tags,omitempty"`
	Group                       *tagRefView            `json:"group,omitempty"`
	ClientID                    *string                `json:"client_id,omitempty"`
	Status                      domain.Status          `json:"status"`
	ManualDisabled              bool                   `json:"manual_disabled"`
	QuotaSuspended              bool                   `json:"quota_suspended"`
	CredentialRevision          int64                  `json:"credential_revision"`
	CredentialConfigured        bool                   `json:"credential_configured"`
	CredentialVerifiedOperators int64                  `json:"credential_verified_operators"`
	CredentialLastVerifiedAtMS  *int64                 `json:"credential_last_verified_at_ms,omitempty"`
	CredentialKeyExpiresAtMS    *int64                 `json:"credential_key_expires_at_ms,omitempty"`
	CredentialLastUsedAtMS      *int64                 `json:"credential_last_used_at_ms,omitempty"`
	Assignee                    *assigneeView          `json:"assignee,omitempty"`
	AssigneeKeyManage           bool                   `json:"assignee_key_manage"`
	Permissions                 permsView              `json:"permissions"`
	Revision                    int64                  `json:"revision"`
	ProductQuota                *domain.ProductQuota   `json:"product_quota,omitempty"`
	FinanceBalance              *domain.FinanceBalance `json:"finance_balance,omitempty"`
}

type tagRefView struct {
	UUID string `json:"uuid"`
	Name string `json:"name"`
}

type assigneeView struct {
	MembershipID int64  `json:"membership_id"`
	Name         string `json:"name"`
	Email        string `json:"email"`
}

type permsView struct {
	ManageStore     bool `json:"manage_store"`
	EditName        bool `json:"edit_name"`
	ManageKeyGrants bool `json:"manage_key_grants"`
	TestKey         bool `json:"test_key"`
	ManageKey       bool `json:"manage_key"`
	DeleteStore     bool `json:"delete_store"`
	ManageTags      bool `json:"manage_tags"`
}

type tagViewWire struct {
	UUID       string `json:"uuid"`
	Name       string `json:"name"`
	StoreCount int64  `json:"store_count"`
}

type quotaChangeView struct {
	UUID        string `json:"uuid"`
	CreateOrder int64  `json:"create_order"`
	Action      string `json:"action"`
}

type quotaChangesView struct {
	Suspend []quotaChangeView `json:"suspend"`
	Restore []quotaChangeView `json:"restore"`
}

type tombstoneView struct {
	UUID        string `json:"uuid"`
	DeletedAtMS int64  `json:"deleted_at_ms"`
	Revision    int64  `json:"revision"`
}

type rosterData struct {
	Stores               []storeView       `json:"stores"`
	Tags                 []tagViewWire     `json:"tags,omitempty"`
	Groups               []tagViewWire     `json:"groups,omitempty"`
	StoreLimit           int64             `json:"store_limit"`
	StoresUsed           int64             `json:"stores_used"`
	Suspended            int64             `json:"suspended"`
	QuotaRevision        *int64            `json:"quota_revision,omitempty"`
	QuotaSuspendedStores []quotaChangeView `json:"quota_suspended_stores,omitempty"`
	Tombstones           []tombstoneView   `json:"tombstones,omitempty"`
}

type storeData struct {
	Store        storeView         `json:"store"`
	QuotaChanges *quotaChangesView `json:"quota_changes,omitempty"`
}

func toStoreView(row domain.Row, actor domain.Actor, nowMS int64) storeView {
	perms := row.Permissions(actor, nowMS)
	out := storeView{
		UUID:                        row.UUID,
		CreateOrder:                 row.CreateOrder,
		Name:                        row.Name,
		ClientID:                    row.ClientID,
		Status:                      row.Status(),
		ManualDisabled:              row.ManualDisabled,
		QuotaSuspended:              row.QuotaSuspended,
		CredentialRevision:          row.CredentialRevision,
		CredentialConfigured:        row.CredentialConfigured,
		CredentialVerifiedOperators: row.CredentialVerifiedOperators,
		CredentialLastVerifiedAtMS:  row.CredentialLastVerifiedAtMS,
		CredentialKeyExpiresAtMS:    row.CredentialKeyExpiresAtMS,
		CredentialLastUsedAtMS:      row.CredentialLastUsedAtMS,
		AssigneeKeyManage:           row.AssigneeKeyManageVisible(),
		Revision:                    row.Revision,
		ProductQuota:                row.ProductQuotaView(),
		FinanceBalance:              row.FinanceBalanceView(),
		Permissions: permsView{
			ManageStore:     perms.ManageStore,
			EditName:        perms.EditName,
			ManageKeyGrants: perms.ManageKeyGrants,
			TestKey:         perms.TestKey,
			ManageKey:       perms.ManageKey,
			DeleteStore:     perms.DeleteStore,
			ManageTags:      perms.ManageTags,
		},
	}
	if len(row.Tags) > 0 {
		out.Tags = make([]tagRefView, 0, len(row.Tags))
		for _, tag := range row.Tags {
			out.Tags = append(out.Tags, tagRefView{UUID: tag.UUID, Name: tag.Name})
		}
	}
	if row.Group != nil {
		out.Group = &tagRefView{UUID: row.Group.UUID, Name: row.Group.Name}
	}
	if assignee := row.Assignee(); assignee != nil {
		out.Assignee = &assigneeView{
			MembershipID: assignee.MembershipID,
			Name:         assignee.Name,
			Email:        assignee.Email,
		}
	}
	return out
}

func toQuotaChanges(changes domain.QuotaChanges) *quotaChangesView {
	changes = changes.Ensure()
	out := &quotaChangesView{
		Suspend: make([]quotaChangeView, 0, len(changes.Suspend)),
		Restore: make([]quotaChangeView, 0, len(changes.Restore)),
	}
	for _, change := range changes.Suspend {
		out.Suspend = append(out.Suspend, quotaChangeView(change))
	}
	for _, change := range changes.Restore {
		out.Restore = append(out.Restore, quotaChangeView(change))
	}
	return out
}

func toRosterData(roster domain.Roster, actor domain.Actor, nowMS int64) rosterData {
	out := rosterData{
		Stores:        make([]storeView, 0, len(roster.Stores)),
		StoreLimit:    roster.StoreLimit,
		StoresUsed:    roster.StoresUsed,
		Suspended:     roster.Suspended,
		QuotaRevision: roster.QuotaRevision,
	}
	for _, row := range roster.Stores {
		out.Stores = append(out.Stores, toStoreView(row, actor, nowMS))
	}
	if len(roster.Tags) > 0 {
		out.Tags = toTagViews(roster.Tags)
	}
	if len(roster.Groups) > 0 {
		out.Groups = toTagViews(roster.Groups)
	}
	if len(roster.QuotaSuspendedStores) > 0 {
		out.QuotaSuspendedStores = make([]quotaChangeView, 0, len(roster.QuotaSuspendedStores))
		for _, change := range roster.QuotaSuspendedStores {
			out.QuotaSuspendedStores = append(out.QuotaSuspendedStores, quotaChangeView(change))
		}
	}
	if len(roster.Tombstones) > 0 {
		out.Tombstones = make([]tombstoneView, 0, len(roster.Tombstones))
		for _, tombstone := range roster.Tombstones {
			out.Tombstones = append(out.Tombstones, tombstoneView{
				UUID: tombstone.UUID, DeletedAtMS: tombstone.DeletedAtMS, Revision: tombstone.Revision,
			})
		}
	}
	return out
}

func toTagViews(views []domain.TagView) []tagViewWire {
	out := make([]tagViewWire, 0, len(views))
	for _, view := range views {
		out = append(out, tagViewWire{UUID: view.UUID, Name: view.Name, StoreCount: view.StoreCount})
	}
	return out
}
