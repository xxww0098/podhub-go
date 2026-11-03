package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediagen "github.com/xxww0098/podhub-go/internal/media/http/gen"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type mediaPresignBody struct {
	ByteLength int64  `json:"byte_length"`
	Batch      string `json:"batch"`
	Purpose    string `json:"purpose"`
}

type mediaErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type mediaFailure struct {
	status int
	code   string
	text   string
}

func (e *mediaFailure) Error() string { return e.text }

func mediaInvalid() error     { return &mediaFailure{400, "VALIDATION", "媒体上传请求无效"} }
func mediaUnavailable() error { return &mediaFailure{503, "UNAVAILABLE", "对象存储暂不可用"} }
func sliceAccountUnavailable() error {
	return &mediaFailure{503, "UNAVAILABLE", "工作空间存储桶尚未就绪，请联系所有者在设置中检查"}
}
func mediaConflict() error {
	return &mediaFailure{409, "CONFLICT", "上传对象或存储配置已变化，请重新上传"}
}

// The single-object route uses the same reservation and confirmation identity
// as batch upload; its existing flat wire format remains unchanged.
func (s *Server) PostMediaObjectPresign(w http.ResponseWriter, r *http.Request, digest, extension string) {
	var in mediaPresignBody
	if err := decodeMedia(r, &in); err != nil || (in.Purpose != "" && in.Purpose != "workflow-media") {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	p, workspace, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	var batch *string
	if in.Batch != "" {
		batch = &in.Batch
	}
	rows, err := s.presignMedia(r.Context(), p, workspace, batch, []mediagen.MediaObjectBatchPresignItem{{Digest: digest, Extension: extension, ByteLength: in.ByteLength}})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	row := rows[0]
	jsonwire.Write(w, http.StatusOK, mediagen.MediaPresignResponse{
		ObjectKey: row.ObjectKey, PublicUrl: row.PublicUrl, Url: row.Upload.Url,
		ContentType: row.Upload.Headers.ContentType, IfNoneMatch: row.Upload.Headers.IfNoneMatch,
		ChecksumSha256: row.Upload.Headers.ChecksumSha256, ExpiresAtMs: row.Upload.ExpiresAtMs, UploadTicket: *row.UploadTicket,
	})
}

func (s *Server) mediaActor(r *http.Request, expected string) (access.Principal, string, error) {
	p, refusal, err := s.principal(r)
	if err != nil {
		return p, "", mediaUnavailable()
	}
	if refusal != nil {
		return p, "", &mediaFailure{refusal.Status, mediaCode(refusal), refusal.Message}
	}
	if status, message, ok := access.OrgMember(p); !ok {
		return p, "", &mediaFailure{status, "FORBIDDEN", message}
	}
	workspace, err := s.workspaceUUID(r.Context(), p.OrgID)
	if err != nil || workspace == "" {
		return p, "", mediaUnavailable()
	}
	if expected != "" && expected != workspace {
		return p, "", &mediaFailure{403, "FORBIDDEN", "工作空间已变化，请重新准备媒体"}
	}
	return p, workspace, nil
}

func (s *Server) mediaAccount(ctx context.Context, actor access.Principal) (sign.Account, bool) {
	if s == nil {
		return sign.Account{}, false
	}
	var account *sign.Account
	if s.Media != nil {
		var err error
		account, err = s.Media(ctx, actor)
		if err != nil {
			return sign.Account{}, false
		}
	} else {
		err := s.transitTx(ctx, actor, false, func(tx pgx.Tx) error {
			row, err := mediarepo.ActiveSliceStorage(ctx, tx, actor.OrgID, s.SliceStorageKey)
			if err == nil && row != nil {
				account = &row.Account
			}
			return err
		})
		if err != nil {
			return sign.Account{}, false
		}
	}
	if account == nil {
		return sign.Account{}, false
	}
	a := *account
	if strings.TrimSpace(a.ID) == "" {
		return sign.Account{}, false
	}
	if s.Media != nil && (a.Provider == sign.ProviderGeneric || a.Provider == sign.ProviderCloudflare) && storage.LoopbackHost(a.Endpoint) && a.PublicBaseURL != "" && a.AccessKeyID != "" && a.SecretAccessKey != "" {
		return a, true
	}
	err := (media.Config{Role: media.RoleTransit, Provider: string(a.Provider), Endpoint: a.Endpoint,
		Region: a.Region, Bucket: a.Bucket, KeyPrefix: a.KeyPrefix, PublicBaseURL: a.PublicBaseURL,
		ForcePathStyle: a.ForcePathStyle, AccessKeyID: a.AccessKeyID, SecretAccessKey: a.SecretAccessKey,
		SessionToken: a.SessionToken}).ValidateSliceStorage()
	return a, err == nil
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
	return strings.ToLower(workspace), err
}

func decodeMedia(r *http.Request, value any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(value); err != nil {
		return err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return mediaInvalid()
	}
	return nil
}

func mediaCode(refusal *access.Refusal) string {
	if refusal.Status == http.StatusForbidden {
		return "FORBIDDEN"
	}
	return "AUTH_INVALID"
}

func writeMedia(w http.ResponseWriter, status int, message, code string) {
	jsonwire.Write(w, status, mediaErrorBody{Error: message, Code: code})
}

func mediaFailureDetails(err error) *mediaFailure {
	var failure *mediaFailure
	if errors.As(err, &failure) {
		return failure
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		slog.Error("media database operation failed", "code", databaseError.Code, "message", databaseError.Message)
	}
	return &mediaFailure{503, "UNAVAILABLE", "媒体操作暂不可用"}
}

func writeMediaFailure(w http.ResponseWriter, err error) {
	failure := mediaFailureDetails(err)
	writeMedia(w, failure.status, failure.text, failure.code)
}
