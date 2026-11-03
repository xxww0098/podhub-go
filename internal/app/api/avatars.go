package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

const (
	avatarMinBytes = 3
	avatarMaxBytes = 256 * 1024
	avatarTTL      = 15 * time.Minute
)

type avatarErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeAvatarError(w http.ResponseWriter, status int, code, message string) {
	jsonwire.Write(w, status, avatarErrorBody{Error: message, Code: code})
}

type directUploadHeaders struct {
	ContentType    string `json:"content_type"`
	IfNoneMatch    string `json:"if_none_match"`
	ChecksumSHA256 string `json:"checksum_sha256,omitempty"`
}

type directUploadGrant struct {
	URL         string              `json:"url"`
	Headers     directUploadHeaders `json:"headers"`
	ExpiresAtMS int64               `json:"expires_at_ms"`
}

type directUploadTarget struct {
	UploadTicket   string             `json:"upload_ticket"`
	AlreadyPresent bool               `json:"already_present"`
	Upload         *directUploadGrant `json:"upload"`
	Multipart      any                `json:"multipart"`
}

// GetMyAvatar serves GET /api/avatars/me as the stored JPEG bytes.
func (s *Server) GetMyAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := s.avatarPrincipal(w, r)
	if !ok {
		return
	}
	var data []byte
	var revision *int64
	err := db.InTx(r.Context(), s.Pool, db.AppRole(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT avatar_bytes, avatar_updated_at_ms FROM account_profiles WHERE user_id=$1`, p.UserID).Scan(&data, &revision)
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && len(data) == 0) {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "头像不存在")
		return
	}
	if err != nil {
		slog.Error("avatar read failed", "user", p.UserID, "err", err)
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像读取暂不可用")
		return
	}
	writeAvatarBytes(w, r, data, revision)
}

// DeleteMyAvatar serves DELETE /api/avatars/me.
func (s *Server) DeleteMyAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := s.avatarPrincipal(w, r)
	if !ok {
		return
	}
	if err := db.InTx(r.Context(), s.Pool, db.AppRole(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `UPDATE account_profiles SET avatar_bytes=NULL, avatar_updated_at_ms=NULL, updated_at=clock_timestamp() WHERE user_id=$1`, p.UserID)
		return err
	}); err != nil {
		slog.Error("avatar clear failed", "user", p.UserID, "err", err)
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像清空暂不可用")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetWorkspaceAvatar serves GET /api/avatars/workspaces/{workspace_id}.
func (s *Server) GetWorkspaceAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := s.avatarPrincipal(w, r)
	if !ok {
		return
	}
	workspaceID, err := positivePathInt(r, "workspace_id")
	if err != nil || workspaceID != p.OrgID {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "工作空间不存在")
		return
	}
	var data []byte
	var revision *int64
	err = db.InTx(r.Context(), s.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT o.avatar_bytes, o.avatar_updated_at_ms
			FROM organizations o
			JOIN organization_members m ON m.org_id=o.id
			WHERE o.id=$1 AND m.user_id=$2 AND m.status='active' AND NOT m.manual_disabled
			  AND o.dissolved_at IS NULL`, workspaceID, p.UserID).Scan(&data, &revision)
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && len(data) == 0) {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "工作空间头像不存在")
		return
	}
	if err != nil {
		slog.Error("workspace avatar read failed", "workspace", workspaceID, "err", err)
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像读取暂不可用")
		return
	}
	writeAvatarBytes(w, r, data, revision)
}

// InitWorkspaceAvatar serves POST /api/avatars/workspaces/{workspace_id}/upload.
func (s *Server) InitWorkspaceAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := s.avatarPrincipal(w, r)
	if !ok {
		return
	}
	workspaceID, err := positivePathInt(r, "workspace_id")
	if err != nil {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "工作空间参数无效")
		return
	}
	if workspaceID != p.OrgID {
		writeAvatarError(w, http.StatusForbidden, "FORBIDDEN", "无权修改该工作空间头像")
		return
	}
	if ok, err := s.workspaceAvatarEditable(r.Context(), p, workspaceID); err != nil {
		slog.Error("workspace avatar permission read failed", "workspace", workspaceID, "err", err)
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像服务暂不可用")
		return
	} else if !ok {
		writeAvatarError(w, http.StatusForbidden, "FORBIDDEN", "只有工作空间所有者可以修改头像")
		return
	}

	var spec struct {
		Bytes       int64  `json:"bytes"`
		SHA256      string `json:"sha256"`
		ContentType string `json:"content_type"`
	}
	if err := decodeAvatarJSON(r, &spec); err != nil {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "上传参数无效")
		return
	}
	if spec.Bytes < avatarMinBytes || spec.Bytes > avatarMaxBytes || !avatarSHA256(spec.SHA256) {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "图片须为不超过 256KB 的 JPEG")
		return
	}
	if strings.TrimSpace(strings.ToLower(spec.ContentType)) != "image/jpeg" {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "图片须为 JPEG")
		return
	}
	now := s.avatarNow()
	expires := now.Add(avatarTTL)
	ticket := uuid.NewString()
	err = db.InTx(r.Context(), s.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `INSERT INTO media_uploads
			(id, org_id, idempotency_key, expected_sha256, expected_size, expected_mime, storage_key, state, created_by, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
			ticket, p.OrgID, "avatar:"+ticket, spec.SHA256, spec.Bytes, "image/jpeg", avatarStorageKey(workspaceID), p.UserID, expires)
		return err
	})
	if err != nil {
		slog.Error("avatar upload init failed", "workspace", workspaceID, "err", err)
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像上传暂不可用")
		return
	}
	digest, _ := hex.DecodeString(spec.SHA256)
	target := directUploadTarget{
		UploadTicket: ticket,
		Upload: &directUploadGrant{
			URL: s.avatarUploadURL(r, workspaceID, ticket),
			Headers: directUploadHeaders{
				ContentType:    "image/jpeg",
				IfNoneMatch:    "*",
				ChecksumSHA256: base64.StdEncoding.EncodeToString(digest),
			},
			ExpiresAtMS: expires.UnixMilli(),
		},
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data directUploadTarget `json:"data"`
	}{Data: target})
}

// PutWorkspaceAvatarUpload serves the ticket-authorised PUT grant URL. It is
// deliberately unauthenticated at the session layer: the browser upload uses
// credentials:"omit" and the unguessable ticket is the bearer.
func (s *Server) PutWorkspaceAvatarUpload(w http.ResponseWriter, r *http.Request) {
	workspaceID, err := positivePathInt(r, "workspace_id")
	if err != nil {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "工作空间参数无效")
		return
	}
	ticketID := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if ticketID == "" {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "上传授权不存在")
		return
	}
	ticket, err := s.loadAvatarTicket(r.Context(), ticketID)
	if err != nil {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "上传授权不存在")
		return
	}
	if ticket.orgID != workspaceID || ticket.storageKey != avatarStorageKey(workspaceID) {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "上传授权不存在")
		return
	}
	if ticket.state == "finalized" {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	if ticket.state != "pending" || !s.avatarNow().Before(ticket.expiresAt) {
		writeAvatarError(w, http.StatusGone, "VALIDATION", "上传授权已过期，请重新上传")
		return
	}

	body, err := readAvatarBody(r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAvatarError(w, http.StatusRequestEntityTooLarge, "VALIDATION", "图片超过 256KB")
			return
		}
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "无法读取图片")
		return
	}
	if int64(len(body)) != ticket.expectedSize {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "图片大小与上传声明不一致")
		return
	}
	sum := sha256.Sum256(body)
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(ticket.expectedSHA256)) != 1 {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "图片校验失败")
		return
	}
	if _, format, err := image.DecodeConfig(bytes.NewReader(body)); err != nil || format != "jpeg" {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "图片须为 JPEG")
		return
	}
	if contentType := strings.TrimSpace(r.Header.Get("Content-Type")); contentType != "" {
		if mediaType, _, err := mime.ParseMediaType(contentType); err != nil || mediaType != "image/jpeg" {
			writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "图片须为 JPEG")
			return
		}
	}

	nowMS := s.avatarNow().UnixMilli()
	err = db.InTx(r.Context(), s.Pool, db.Worker(), func(tx pgx.Tx) error {
		var state string
		var expiresAt time.Time
		var expectedSize int64
		var expectedSHA, storageKey string
		if err := tx.QueryRow(r.Context(), `SELECT state, expires_at, expected_size, expected_sha256, storage_key
			FROM media_uploads WHERE id=$1 FOR UPDATE`, ticketID).Scan(&state, &expiresAt, &expectedSize, &expectedSHA, &storageKey); err != nil {
			return err
		}
		if state == "finalized" {
			return errAvatarAlreadyFinalized
		}
		if state != "pending" || !s.avatarNow().Before(expiresAt) || expectedSize != int64(len(body)) ||
			storageKey != avatarStorageKey(workspaceID) || expectedSHA != ticket.expectedSHA256 {
			return errAvatarTicketInvalid
		}
		var revision int64
		if err := tx.QueryRow(r.Context(), `UPDATE organizations
			SET avatar_bytes=$1, avatar_updated_at_ms=GREATEST(COALESCE(avatar_updated_at_ms,0)+1,$2), updated_at=clock_timestamp()
			WHERE id=$3 AND dissolved_at IS NULL
			RETURNING avatar_updated_at_ms`, body, nowMS, workspaceID).Scan(&revision); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `UPDATE media_uploads SET state='finalized', finalized_at=clock_timestamp() WHERE id=$1`, ticketID)
		return err
	})
	if errors.Is(err, errAvatarAlreadyFinalized) {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, errAvatarTicketInvalid) {
		writeAvatarError(w, http.StatusGone, "VALIDATION", "上传授权已过期，请重新上传")
		return
	}
	if err != nil {
		slog.Error("avatar byte upload failed", "workspace", workspaceID, "err", err)
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像上传暂不可用")
		return
	}
	w.WriteHeader(http.StatusOK)
}

// PutWorkspaceAvatar serves PUT /api/avatars/workspaces/{workspace_id}.
func (s *Server) PutWorkspaceAvatar(w http.ResponseWriter, r *http.Request) {
	p, ok := s.avatarPrincipal(w, r)
	if !ok {
		return
	}
	workspaceID, err := positivePathInt(r, "workspace_id")
	if err != nil {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "工作空间参数无效")
		return
	}
	if workspaceID != p.OrgID {
		writeAvatarError(w, http.StatusForbidden, "FORBIDDEN", "无权修改该工作空间头像")
		return
	}
	if ok, err := s.workspaceAvatarEditable(r.Context(), p, workspaceID); err != nil {
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "头像服务暂不可用")
		return
	} else if !ok {
		writeAvatarError(w, http.StatusForbidden, "FORBIDDEN", "只有工作空间所有者可以修改头像")
		return
	}
	var in struct {
		UploadTicket string `json:"upload_ticket"`
	}
	if err := decodeAvatarJSON(r, &in); err != nil || strings.TrimSpace(in.UploadTicket) == "" {
		writeAvatarError(w, http.StatusBadRequest, "VALIDATION", "上传参数无效")
		return
	}
	ticket, err := s.loadAvatarTicket(r.Context(), in.UploadTicket)
	if err != nil || ticket.orgID != workspaceID || ticket.storageKey != avatarStorageKey(workspaceID) {
		writeAvatarError(w, http.StatusConflict, "CONFLICT", "cloud_media_complete_missing")
		return
	}
	if ticket.state != "finalized" {
		writeAvatarError(w, http.StatusConflict, "CONFLICT", "cloud_media_complete_missing")
		return
	}
	var revision *int64
	err = db.InTx(r.Context(), s.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT avatar_updated_at_ms FROM organizations WHERE id=$1 AND dissolved_at IS NULL`, workspaceID).Scan(&revision)
	})
	if err != nil || revision == nil {
		writeAvatarError(w, http.StatusConflict, "CONFLICT", "cloud_media_complete_missing")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			AvatarRevision int64 `json:"avatar_revision"`
		} `json:"data"`
	}{Data: struct {
		AvatarRevision int64 `json:"avatar_revision"`
	}{AvatarRevision: *revision}})
}

func (s *Server) avatarPrincipal(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeAvatarError(w, http.StatusServiceUnavailable, "INTERNAL", "身份服务暂不可用")
		return access.Principal{}, false
	}
	if refusal != nil {
		writeAvatarError(w, refusal.Status, adminCode(refusal), refusal.Message)
		return access.Principal{}, false
	}
	if p.UserID <= 0 {
		writeAvatarError(w, http.StatusUnauthorized, "AUTH_INVALID", access.MsgUnauthenticated)
		return access.Principal{}, false
	}
	return p, true
}

func (s *Server) workspaceAvatarEditable(ctx context.Context, p access.Principal, workspaceID int64) (bool, error) {
	var role string
	err := db.InTx(ctx, s.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT m.role
			FROM organization_members m
			JOIN organizations o ON o.id=m.org_id
			WHERE m.org_id=$1 AND m.user_id=$2 AND m.status='active' AND NOT m.manual_disabled
			  AND o.dissolved_at IS NULL`, workspaceID, p.UserID).Scan(&role)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return strings.EqualFold(role, "owner"), nil
}

type avatarTicket struct {
	orgID          int64
	expectedSHA256 string
	expectedSize   int64
	storageKey     string
	state          string
	expiresAt      time.Time
}

var (
	errAvatarAlreadyFinalized = errors.New("avatar already finalized")
	errAvatarTicketInvalid    = errors.New("avatar ticket invalid")
)

func (s *Server) loadAvatarTicket(ctx context.Context, ticketID string) (avatarTicket, error) {
	var ticket avatarTicket
	err := db.InTx(ctx, s.Pool, db.Worker(), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT org_id, expected_sha256, expected_size, storage_key, state, expires_at
			FROM media_uploads WHERE id=$1`, ticketID).Scan(&ticket.orgID, &ticket.expectedSHA256, &ticket.expectedSize, &ticket.storageKey, &ticket.state, &ticket.expiresAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return avatarTicket{}, errAvatarTicketInvalid
	}
	return ticket, err
}

func (s *Server) avatarNow() time.Time {
	if s != nil && s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) avatarUploadURL(r *http.Request, workspaceID int64, ticket string) string {
	base := strings.TrimRight(strings.TrimSpace(s.PublicURL), "/")
	if base == "" {
		scheme := "http"
		if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	return base + "/api/avatars/workspaces/" + strconv.FormatInt(workspaceID, 10) + "/upload?ticket=" + ticket
}

func avatarStorageKey(workspaceID int64) string {
	return "avatar:" + strconv.FormatInt(workspaceID, 10)
}

func avatarSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func decodeAvatarJSON(r *http.Request, value any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(value); err != nil {
		return err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return errors.New("avatar body has trailing data")
	}
	return nil
}

func readAvatarBody(r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, avatarMaxBytes+1)
	return io.ReadAll(r.Body)
}

func writeAvatarBytes(w http.ResponseWriter, r *http.Request, data []byte, revision *int64) {
	if len(data) == 0 {
		writeAvatarError(w, http.StatusNotFound, "NOT_FOUND", "头像不存在")
		return
	}
	if revision != nil {
		etag := "\"" + strconv.FormatInt(*revision, 10) + "\""
		w.Header().Set("ETag", etag)
		if match := strings.TrimSpace(r.Header.Get("If-None-Match")); match != "" && match == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=60, must-revalidate")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
