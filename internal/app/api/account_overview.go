package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	usersdomain "github.com/xxww0098/podhub-go/internal/admin/users/domain"
	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

// AccountOverview adapts the existing session projection for the signed-in shell.
func (s *Server) AccountOverview(w http.ResponseWriter, r *http.Request) {
	res := s.identity().Session(r)
	if res.Status != http.StatusOK {
		identity.WriteResult(w, res)
		return
	}
	var session struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(res.Body, &session); err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	data := map[string]any{"session": session.Data, "owned_count": int64(0), "owned_limit": usersdomain.OwnedLimit()}
	for _, key := range []string{"workspaces", "unusable_workspaces", "active_workspace", "account_mode", "accounts"} {
		if value, ok := session.Data[key]; ok && string(value) != "null" {
			data[key] = value
		}
		delete(session.Data, key)
	}
	if string(session.Data["authenticated"]) == "true" {
		p, refusal, err := s.principal(r)
		if err != nil || refusal != nil {
			writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
			return
		}
		standing, err := sqlc.New(s.Pool).AccountStanding(r.Context(), p.UserID)
		if err != nil {
			writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
			return
		}
		data["owned_count"] = standing.OwnedCount
	}
	// Session endpoints expose revision numbers; shell views expose stamped URLs.
	stampAvatar := func(item map[string]json.RawMessage, path string) {
		if revision, ok := item["avatar_revision"]; ok {
			item["avatar_url"], _ = json.Marshal(path + "?v=" + string(revision))
			delete(item, "avatar_revision")
		}
	}
	stampAvatar(session.Data, "/api/avatars/me")
	for _, key := range []string{"workspaces", "unusable_workspaces", "accounts", "active_workspace"} {
		raw, ok := data[key].(json.RawMessage)
		if !ok {
			continue
		}
		var items []map[string]json.RawMessage
		if key == "active_workspace" {
			raw = append(append([]byte{'['}, raw...), ']')
		}
		if err := json.Unmarshal(raw, &items); err != nil {
			writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
			return
		}
		for _, item := range items {
			var path string
			if key == "accounts" {
				var id string
				_ = json.Unmarshal(item["uuid"], &id)
				path = "/api/avatars/users/" + id
			} else {
				var id int64
				_ = json.Unmarshal(item["id"], &id)
				path = "/api/avatars/workspaces/" + strconv.FormatInt(id, 10)
			}
			stampAvatar(item, path)
		}
		if key == "active_workspace" {
			data[key] = items[0]
		} else {
			data[key] = items
		}
	}
	for _, cookie := range res.Cookies {
		w.Header().Add("Set-Cookie", cookie)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"data": data})
}
