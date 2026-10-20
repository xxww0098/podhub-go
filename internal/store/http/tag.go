package storehttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// The three Workspace Store tag routes. They share PathTags for the create
// and the collection, and PathTag for the rename and the delete.
const (
	// PathTags creates a tag.
	PathTags = "/api/workspaces/stores/tags"
	// PathTag renames or deletes one tag.
	PathTag = "/api/workspaces/stores/tags/{uuid}"
)

// TagActions is the tag half of the store service.
type TagActions interface {
	CreateTag(ctx context.Context, orgID, userID int64, role, name string) (domain.Tag, error)
	RenameTag(ctx context.Context, orgID, userID int64, role, tagUUID, name string) (domain.Tag, error)
	DeleteTag(ctx context.Context, orgID, userID int64, role, tagUUID string) (domain.TagDeleted, error)
}

type tagBody struct {
	Name string `json:"name"`
}

type tagView struct {
	UUID       string `json:"uuid"`
	Name       string `json:"name"`
	StoreCount int64  `json:"store_count"`
}

type tagData struct {
	Tag tagView `json:"tag"`
}

type tagDeleteData struct {
	UUID    string `json:"uuid"`
	Deleted bool   `json:"deleted"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func tagJSON(tag domain.Tag) tagView {
	return tagView{UUID: tag.UUID, Name: tag.Name, StoreCount: tag.StoreCount}
}

// readTagName decodes {"name": ...} with unknown fields rejected, matching the
// Rust strict_json extractor.
func readTagName(r *http.Request) (string, bool) {
	if !jsonContent(r.Header.Get("Content-Type")) {
		return "", false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8192))
	if err != nil {
		return "", false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body tagBody
	if err := dec.Decode(&body); err != nil {
		return "", false
	}
	return body.Name, true
}

// createTag is POST PathTags.
func (h handler) createTag(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, "FORBIDDEN")
		return
	}
	name, ok := readTagName(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return
	}
	if h.Tags == nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
		return
	}
	tag, err := h.Tags.CreateTag(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, name)
	if err != nil {
		writeTagFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tagData{Tag: tagJSON(tag)})
}

// renameTag is PUT PathTag.
func (h handler) renameTag(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, "FORBIDDEN")
		return
	}
	tagUUID, ok := validTagUUID(w, r)
	if !ok {
		return
	}
	name, ok := readTagName(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return
	}
	if h.Tags == nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
		return
	}
	tag, err := h.Tags.RenameTag(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, tagUUID, name)
	if err != nil {
		writeTagFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tagData{Tag: tagJSON(tag)})
}

// deleteTag is DELETE PathTag.
func (h handler) deleteTag(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, "FORBIDDEN")
		return
	}
	tagUUID, ok := validTagUUID(w, r)
	if !ok {
		return
	}
	if h.Tags == nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
		return
	}
	deleted, err := h.Tags.DeleteTag(r.Context(), p.OrgID, p.UserID, p.WorkspaceRole, tagUUID)
	if err != nil {
		writeTagFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tagDeleteData{UUID: deleted.UUID, Deleted: deleted.Deleted})
}

// validTagUUID lower-cases and checks the path parameter. A non-UUID answers
// 400 before any transaction opens, as the Rust validator does.
func validTagUUID(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := chi.URLParam(r, "uuid")
	if !uuidPattern.MatchString(raw) {
		writeErr(w, http.StatusBadRequest, "标签 UUID 无效", "VALIDATION")
		return "", false
	}
	return raw, true
}

// writeTagFail maps a tag failure to the Rust status and code, with the same
// Chinese messages the store domain already uses.
func writeTagFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, contract.ErrForbidden):
		writeErr(w, http.StatusForbidden, "需要主管权限", "FORBIDDEN")
	case errors.Is(err, contract.ErrTagNotFound):
		writeErr(w, http.StatusNotFound, "标签不存在", "NOT_FOUND")
	case errors.Is(err, contract.ErrTagExists):
		writeErr(w, http.StatusConflict, "标签名已存在", "CONFLICT")
	case errors.Is(err, contract.ErrTagName):
		writeErr(w, http.StatusBadRequest, "标签名称不能为空", "VALIDATION")
	case errors.Is(err, contract.ErrTagNameLength):
		writeErr(w, http.StatusBadRequest, "标签名过长", "VALIDATION")
	case errors.Is(err, contract.ErrNoTenant):
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_REQUIRED")
	default:
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
	}
}
