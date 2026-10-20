package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/service/upload"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// mediaPresignBody is the transit batch presign request. There is no checksum
// switch: the design makes x-amz-checksum-sha256 mandatory, so a client cannot
// turn it off.
type mediaPresignBody struct {
	ByteLength uint64 `json:"byte_length"`
	Batch      string `json:"batch"`
	Purpose    string `json:"purpose"`
}

type mediaErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

// PostMediaObjectPresign signs one transit batch PUT for the caller's
// workspace. The route sits behind identity.Middleware. The org id comes from
// the session principal, and the workspace uuid is read as podhub_app.
//
// The object lives at most until the next 04:00 Shanghai clear.
func (s *Server) PostMediaObjectPresign(w http.ResponseWriter, r *http.Request, digest string, extension string) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeMedia(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	if refusal != nil {
		writeMedia(w, refusal.Status, refusal.Message, mediaCode(refusal))
		return
	}
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeMedia(w, http.StatusForbidden, access.MsgNoWorkspace, "FORBIDDEN")
		return
	}
	if _, ok := access.ParseWorkspace(p.WorkspaceRole); !ok {
		writeMedia(w, http.StatusForbidden, access.MsgBadWorkspaceRole, "FORBIDDEN")
		return
	}
	account, ok := s.mediaAccount()
	if !ok {
		writeMedia(w, http.StatusServiceUnavailable, "对象存储只接受 127.0.0.1 假桶", "MEDIA_BUCKET")
		return
	}
	var body mediaPresignBody
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || body.ByteLength == 0 {
		writeMedia(w, http.StatusBadRequest, "上传大小或文件类型无效", "MEDIA_INPUT")
		return
	}
	workspace, err := s.workspaceUUID(r.Context(), p.OrgID)
	if err != nil || workspace == "" {
		writeMedia(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
		return
	}
	orgID := p.OrgID
	signed, err := upload.Presign(upload.Request{
		Account:     account,
		Workspace:   workspace,
		Digest:      digest,
		Ext:         extension,
		Batch:       body.Batch,
		ByteLength:  body.ByteLength,
		Now:         s.now(),
		Purpose:     body.Purpose,
		ActorID:     p.UserID,
		WorkspaceID: &orgID,
	})
	if err != nil {
		writeMedia(w, http.StatusBadRequest, err.Error(), "MEDIA_INPUT")
		return
	}
	writeJSON(w, http.StatusOK, signed)
}

func (s *Server) mediaAccount() (sign.Account, bool) {
	if s == nil || s.Media == nil || !storage.LoopbackHost(s.Media.Endpoint) {
		return sign.Account{}, false
	}
	return *s.Media, true
}

func (s *Server) workspaceUUID(ctx context.Context, orgID int64) (string, error) {
	if s != nil && s.Workspace != nil {
		return s.Workspace(ctx, orgID)
	}
	var workspace string
	err := s.tenantRead(ctx, orgID, func(q *sqlc.Queries) error {
		var err error
		workspace, err = q.OrganizationUUID(ctx, orgID)
		return err
	})
	return workspace, err
}

func mediaCode(refusal *access.Refusal) string {
	if refusal.Status == http.StatusForbidden {
		return "FORBIDDEN"
	}
	return "AUTH_INVALID"
}

func writeMedia(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, mediaErrorBody{Error: message, Code: code})
}
