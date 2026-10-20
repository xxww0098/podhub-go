package storehttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The roster and roster-write routes. Each constant is the exact path this
// service mounts; the golden route table pins them.
const (
	// PathRoster lists the Workspace's stores and quota projection.
	PathRoster = "/api/workspaces/stores"
	// PathRosterAssignee reassigns one store.
	PathRosterAssignee = "/api/workspaces/stores/{uuid}/assignee"
	// PathRosterGroups creates a store group.
	PathRosterGroups = "/api/workspaces/stores/groups"
	// PathRosterGroup renames or deletes one store group.
	PathRosterGroup = "/api/workspaces/stores/groups/{uuid}"
	// PathTombstone marks a deleted store's tombstone as seen.
	PathTombstone = "/api/workspaces/stores/{uuid}/tombstone-consumed"
)

// RosterActions is the roster half of the store service.
type RosterActions interface {
	Roster(ctx context.Context, orgID, userID int64) (domain.Roster, domain.Actor, *contract.APIError)
	CreateStore(ctx context.Context, orgID, userID int64, in domain.CreateStoreInput) (domain.Row, domain.QuotaChanges, domain.Actor, *contract.APIError)
	UpdateStore(ctx context.Context, orgID, userID int64, role, uuid string, in domain.UpdateStoreInput) (domain.Row, domain.Actor, *contract.APIError)
	DeleteStore(ctx context.Context, orgID, userID int64, uuid string, revision, nowMS int64) (domain.Row, int64, domain.QuotaChanges, *contract.APIError)
	SetAssignee(ctx context.Context, orgID, userID int64, role, uuid string, assignee *int64, revision int64) (domain.Row, domain.Actor, *contract.APIError)
	ConsumeTombstone(ctx context.Context, orgID, userID int64, uuid string, nowMS int64) (domain.TombstoneResult, *contract.APIError)
	CreateGroup(ctx context.Context, orgID, userID int64, role, name string) (domain.TagView, *contract.APIError)
	RenameGroup(ctx context.Context, orgID, userID int64, role, uuid, name string) (domain.TagView, *contract.APIError)
	DeleteGroup(ctx context.Context, orgID, userID int64, role, uuid string) (string, *contract.APIError)
}

type createStoreBody struct {
	Name                 string  `json:"name"`
	ClientID             *string `json:"client_id"`
	AssigneeMembershipID *int64  `json:"assignee_membership_id"`
}

// updateStoreBody keeps clientId raw: an absent member means "unchanged", an
// explicit null clears it, and only the raw form tells those apart.
type updateStoreBody struct {
	Name      *string         `json:"name"`
	ClientID  json.RawMessage `json:"client_id"`
	KeyManage *bool           `json:"assignee_key_manage"`
	TagUUIDs  *[]string       `json:"tag_uuids"`
	GroupUUID *string         `json:"group_uuid"`
	Revision  int64           `json:"revision"`
}

type statusBody struct {
	ManualDisabled bool  `json:"manual_disabled"`
	Revision       int64 `json:"revision"`
}

type assigneeBody struct {
	AssigneeMembershipID *int64 `json:"assignee_membership_id"`
	Revision             int64  `json:"revision"`
}

type deleteStoreBody struct {
	Revision int64 `json:"revision"`
}

type groupNameBody struct {
	Name string `json:"name"`
}

type tombstoneData struct {
	StoreUUID    string `json:"store_uuid"`
	ConsumedAtMS int64  `json:"consumed_at_ms"`
}

type deleteStoreData struct {
	UUID         string            `json:"uuid"`
	Deleted      bool              `json:"deleted"`
	Revision     int64             `json:"revision"`
	QuotaChanges *quotaChangesView `json:"quota_changes,omitempty"`
}

// listStores is GET PathRoster.
func (h handler) listStores(w http.ResponseWriter, r *http.Request) {
	p, actor, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	roster, loaded, api := h.Roster.Roster(r.Context(), p.OrgID, p.UserID)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	_ = actor
	writeJSON(w, http.StatusOK, toRosterData(roster, loaded, domain.NowMS()))
}

// createStore is POST PathRoster.
func (h handler) createStore(w http.ResponseWriter, r *http.Request) {
	p, actor, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	var body createStoreBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	name, api := domain.NormalizeStoreName(body.Name)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	clientID, api := domain.NormalizeClientID(body.ClientID)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	row, changes, loaded, api := h.Roster.CreateStore(r.Context(), p.OrgID, p.UserID, domain.CreateStoreInput{
		Name: name, ClientID: clientID, AssigneeMembershipID: body.AssigneeMembershipID,
	})
	if api != nil {
		writeAPIError(w, api)
		return
	}
	_ = actor
	writeJSON(w, http.StatusOK, storeData{
		Store:        toStoreView(row, loaded, domain.NowMS()),
		QuotaChanges: toQuotaChanges(changes),
	})
}

// updateStore is PUT PathStore (the {uuid} route the rename handler shares).
func (h handler) updateStore(w http.ResponseWriter, r *http.Request) {
	p, actor, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	var body updateStoreBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	// Absent Client ID means "unchanged"; an explicit null clears it. The raw
	// member is what tells those apart: nil is absent, "null" is a clear.
	clientID, clientIDSet, ok := optionalString(body.ClientID)
	if !ok {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	in := domain.UpdateStoreInput{
		Name:        body.Name,
		ClientID:    clientID,
		ClientIDSet: clientIDSet,
		KeyManage:   body.KeyManage,
		TagUUIDs:    body.TagUUIDs,
		GroupUUID:   body.GroupUUID,
		Revision:    body.Revision,
	}
	row, loaded, api := h.Roster.UpdateStore(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, uuid, in)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	_ = actor
	writeJSON(w, http.StatusOK, storeData{Store: toStoreView(row, loaded, domain.NowMS())})
}

// deleteStore is DELETE PathStore.
func (h handler) deleteStore(w http.ResponseWriter, r *http.Request) {
	p, actor, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	var body deleteStoreBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	_, revision, changes, api := h.Roster.DeleteStore(r.Context(), p.OrgID, p.UserID, uuid, body.Revision, domain.NowMS())
	if api != nil {
		writeAPIError(w, api)
		return
	}
	_ = actor
	writeJSON(w, http.StatusOK, deleteStoreData{
		UUID: uuid, Deleted: true, Revision: revision, QuotaChanges: toQuotaChanges(changes),
	})
}

// setAssignee is POST PathRosterAssignee.
func (h handler) setAssignee(w http.ResponseWriter, r *http.Request) {
	p, actor, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	var body assigneeBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	row, loaded, api := h.Roster.SetAssignee(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, uuid, body.AssigneeMembershipID, body.Revision)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	_ = actor
	writeJSON(w, http.StatusOK, storeData{Store: toStoreView(row, loaded, domain.NowMS())})
}

// consumeTombstone is POST PathTombstone.
func (h handler) consumeTombstone(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	uuid, ok := storeUUID(w, r)
	if !ok {
		return
	}
	result, api := h.Roster.ConsumeTombstone(r.Context(), p.OrgID, p.UserID, uuid, domain.NowMS())
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, tombstoneData{
		StoreUUID: result.StoreUUID, ConsumedAtMS: result.ConsumedAtMS,
	})
}

// createGroup is POST PathRosterGroups.
func (h handler) createGroup(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	var body groupNameBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	view, api := h.Roster.CreateGroup(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, body.Name)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, groupData{
		Group: tagViewWire{UUID: view.UUID, Name: view.Name, StoreCount: view.StoreCount},
	})
}

// renameGroup is PUT PathRosterGroup.
func (h handler) renameGroup(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	var body groupNameBody
	if !readStrict(r, &body) {
		writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
		return
	}
	view, api := h.Roster.RenameGroup(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, chi.URLParam(r, "uuid"), body.Name)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, groupData{
		Group: tagViewWire{UUID: view.UUID, Name: view.Name, StoreCount: view.StoreCount},
	})
}

// deleteGroup is DELETE PathRosterGroup.
func (h handler) deleteGroup(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	uuid, api := h.Roster.DeleteGroup(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, chi.URLParam(r, "uuid"))
	if api != nil {
		writeAPIError(w, api)
		return
	}
	writeJSON(w, http.StatusOK, tagDeleteData{UUID: uuid, Deleted: true})
}

type groupData struct {
	Group tagViewWire `json:"group"`
}

// requireActor resolves the session and the caller's usable membership. Every
// roster route needs both, and every one of them answers the same way when
// either is missing.
func (h handler) requireActor(w http.ResponseWriter, r *http.Request) (Session, domain.Actor, bool) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return Session{}, domain.Actor{}, false
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, contract.CodeForbidden)
		return Session{}, domain.Actor{}, false
	}
	// The membership id is not on the session; the service loads it inside the
	// roster transaction. This placeholder only carries the role the edge gates
	// on, and the service reloads the stored role before any write.
	return p, domain.Actor{UserID: p.UserID, Role: p.WorkspaceRole}, true
}

// storeUUID validates the path parameter before any transaction opens.
func storeUUID(w http.ResponseWriter, r *http.Request) (string, bool) {
	normalized, ok := domain.NormalizeStoreUUID(chi.URLParam(r, "uuid"))
	if !ok {
		writeAPIError(w, contract.Validation(contract.MsgStoreUUID))
		return "", false
	}
	return normalized, true
}

// readStrict decodes one JSON body with unknown fields rejected. A missing or
// non-JSON content type, a body over 8 KiB, and trailing content all refuse.
func readStrict(r *http.Request, out any) bool {
	if !jsonContent(r.Header.Get("Content-Type")) {
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8192))
	if err != nil {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return false
	}
	return !dec.More()
}

// optionalString splits an absent member from an explicit null: an absent
// member leaves raw empty and reports present=false, "null" reports a present
// clear, and anything that is not a string refuses the body.
func optionalString(raw json.RawMessage) (value *string, present bool, ok bool) {
	if len(raw) == 0 {
		return nil, false, true
	}
	if string(raw) == "null" {
		return nil, true, true
	}
	var decoded string
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false, false
	}
	return &decoded, true, true
}

// writeAPIError renders a refusal in the Workspace Store envelope.
func writeAPIError(w http.ResponseWriter, api *contract.APIError) {
	if api == nil {
		writeErr(w, http.StatusInternalServerError, contract.MsgUnavailable, contract.CodeInternal)
		return
	}
	if len(api.Extra) == 0 {
		writeErr(w, api.Status, api.Message, api.Code)
		return
	}
	body := map[string]any{"error": api.Message, "code": api.Code}
	for key, value := range api.Extra {
		body[key] = value
	}
	writeJSON(w, api.Status, body)
}

// isAPI reports whether err is already a refusal this package can render.
func isAPI(err error) bool {
	var api *contract.APIError
	return errors.As(err, &api)
}
