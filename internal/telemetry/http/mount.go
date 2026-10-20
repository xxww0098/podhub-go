// Package telemetryhttp mounts POST /api/events/inbox and POST /api/listing/client-logs.
package telemetryhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
	"github.com/xxww0098/podhub-go/internal/telemetry/service"
)

const (
	msgUnauthenticated = "未登录"
	msgNoWorkspace     = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
	msgBadRole         = "工作空间角色无效"
	msgUnavailable     = "服务暂不可用"
	msgBadJSON         = "请求格式无效"
	msgDevice          = "缺少有效的 X-Podhub-Device-Id 设备标头"
	msgCollectOff      = "客户端日志采集未开启"
	msgLogCount        = "单批需要 1 到 40 条日志"
	msgLogRate         = "客户端日志上报过于频繁"
)

// Session is the caller the assembly layer already resolved.
type Session struct {
	UserID        int64
	OrgID         int64
	WorkspaceRole string
	PlatformRole  string
}

// Refusal is an authentication answer. Status is the HTTP status.
type Refusal struct {
	Status  int
	Message string
}

// Resolve answers one request. A non-nil Refusal wins. A nil session and a
// nil refusal means logged out.
type Resolve func(*http.Request) (*Session, *Refusal, error)

// Actions is the telemetry service.
type Actions interface {
	Ingest(ctx context.Context, in domain.Ingest) (domain.IngestResult, error)
	InsertClientLogs(ctx context.Context, orgID, userID int64, rows []domain.ClientLog) error
}

// Deps is the mount input. Collect is the parsed client-log switch.
// These routes do not read the Ozon write switch. The parsed bool stays in config.
type Deps struct {
	Resolve Resolve
	Actions Actions
	Collect bool
	Now     func() time.Time
	Window  *domain.LogWindow
}

// Mount registers the inbox and client-log routes.
func Mount(r chi.Router, d Deps) {
	if r == nil {
		return
	}
	if d.Window == nil {
		d.Window = &domain.LogWindow{}
	}
	if d.Actions == nil {
		d.Actions = service.New(nil)
	}
	h := handler{Deps: d}
	for _, rt := range Routes() {
		rt := rt
		r.Method(rt.Method, rt.Path, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			switch rt.Path {
			case "/api/listing/client-logs":
				h.clientLogs(w, req)
			default:
				h.inbox(w, req)
			}
		}))
	}
}

type handler struct{ Deps }

type wireError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code, retryAfter string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(wireError{Error: message, Code: code}); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, msgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func writeFail(w http.ResponseWriter, err error) {
	var fail *domain.Fail
	if errors.As(err, &fail) && fail != nil {
		writeErr(w, fail.Status, fail.Message, fail.Code, fail.RetryAfter)
		return
	}
	writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL", "")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		writeErr(w, http.StatusInternalServerError, msgUnavailable, "INTERNAL", "")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func (h handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func (h handler) inbox(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, "FORBIDDEN", "")
		return
	}
	device, ok := domain.DeviceID(r.Header.Get("X-Podhub-Device-Id"), r.Header.Values("X-Podhub-Device-Id") != nil)
	if !ok {
		writeErr(w, http.StatusUnauthorized, msgDevice, "AUTH_REQUIRED", "")
		return
	}
	body, ok := readBody(w, r, domain.EventInboxMaxRequestBytes)
	if !ok {
		return
	}
	if !jsonContent(r.Header.Get("Content-Type")) {
		writeErr(w, http.StatusBadRequest, msgBadJSON, "VALIDATION", "")
		return
	}
	req, err := domain.DecodeInbox(body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, msgBadJSON, "VALIDATION", "")
		return
	}
	if len(req.Events) > domain.EventInboxMaxBatch {
		writeErr(w, http.StatusBadRequest, domain.BatchLimitMessage(), "VALIDATION", "")
		return
	}
	var accepted []domain.AcceptedEvent
	var rejected []domain.RejectedEvent
	for _, item := range req.Events {
		ev, rej := domain.AcceptInboxItem(item)
		if rej != nil {
			rejected = append(rejected, *rej)
			continue
		}
		accepted = append(accepted, ev)
	}
	result, err := h.Actions.Ingest(r.Context(), domain.Ingest{
		OrgID: p.OrgID, UserID: p.UserID, DeviceUID: device,
		Events: accepted, Rejected: rejected, Now: h.now(),
	})
	if err != nil {
		writeFail(w, err)
		return
	}
	if result.Accepted == nil {
		result.Accepted = []string{}
	}
	if result.Rejected == nil {
		result.Rejected = []domain.RejectedEvent{}
	}
	writeJSON(w, http.StatusOK, inboxResponse{
		Data: inboxData{OK: true, Accepted: result.Accepted, Rejected: rejectWire(result.Rejected)},
	})
}

func (h handler) clientLogs(w http.ResponseWriter, r *http.Request) {
	if !h.Collect {
		writeErr(w, http.StatusForbidden, msgCollectOff, "FORBIDDEN", "")
		return
	}
	p, ok := principal(w, r, h.Resolve)
	if !ok {
		return
	}
	if status, msg, bad := workspace(p); bad {
		writeErr(w, status, msg, "FORBIDDEN", "")
		return
	}
	body, ok := readBody(w, r, domain.ClientListingLogMaxBody)
	if !ok {
		return
	}
	if !jsonContent(r.Header.Get("Content-Type")) {
		writeErr(w, http.StatusBadRequest, msgBadJSON, "VALIDATION", "")
		return
	}
	records, err := domain.DecodeClientLogs(body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, msgBadJSON, "VALIDATION", "")
		return
	}
	if len(records) == 0 || len(records) > domain.ClientListingLogMaxRecords {
		writeErr(w, http.StatusBadRequest, msgLogCount, "VALIDATION", "")
		return
	}
	if !h.Window.Allow(p.UserID, h.now().Unix()) {
		writeErr(w, http.StatusTooManyRequests, msgLogRate, "RATE_LIMITED", "")
		return
	}
	prefix := domain.IPPrefix(r.Header.Values("X-Forwarded-For"))
	var rows []domain.ClientLog
	dropped := 0
	for _, raw := range records {
		row, keep := domain.AcceptClientRecord(raw, h.now(), prefix)
		if !keep {
			dropped++
			continue
		}
		rows = append(rows, row)
	}
	if err := h.Actions.InsertClientLogs(r.Context(), p.OrgID, p.UserID, rows); err != nil {
		writeFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, clientResponse{Data: clientData{Accepted: uint32(len(rows)), Dropped: uint32(dropped)}})
}

type inboxResponse struct {
	Data inboxData `json:"data"`
}

type inboxData struct {
	OK       bool       `json:"ok"`
	Accepted []string   `json:"accepted"`
	Rejected []rejectID `json:"rejected"`
}

type rejectID struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type clientResponse struct {
	Data clientData `json:"data"`
}

type clientData struct {
	Accepted uint32 `json:"accepted"`
	Dropped  uint32 `json:"dropped"`
}

func rejectWire(in []domain.RejectedEvent) []rejectID {
	out := make([]rejectID, 0, len(in))
	for _, item := range in {
		out = append(out, rejectID{ID: item.ID, Reason: item.Reason})
	}
	return out
}

func workspace(p Session) (int, string, bool) {
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		return http.StatusForbidden, msgNoWorkspace, true
	}
	if _, ok := access.ParseWorkspace(p.WorkspaceRole); !ok {
		return http.StatusForbidden, msgBadRole, true
	}
	return 0, "", false
}

func principal(w http.ResponseWriter, r *http.Request, resolve Resolve) (Session, bool) {
	if resolve == nil {
		writeErr(w, http.StatusUnauthorized, msgUnauthenticated, "AUTH_REQUIRED", "")
		return Session{}, false
	}
	p, refusal, err := resolve(r)
	if err != nil {
		writeFail(w, err)
		return Session{}, false
	}
	if refusal != nil {
		code := "AUTH_REQUIRED"
		if refusal.Status == http.StatusForbidden {
			code = "FORBIDDEN"
		}
		if refusal.Status == 0 {
			refusal.Status = http.StatusUnauthorized
		}
		writeErr(w, refusal.Status, refusal.Message, code, "")
		return Session{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, msgUnauthenticated, "AUTH_REQUIRED", "")
		return Session{}, false
	}
	return *p, true
}

func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	if r.ContentLength > limit {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	body, err := io.ReadAll(r.Body)
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return nil, false
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, msgBadJSON, "VALIDATION", "")
		return nil, false
	}
	return body, true
}

func jsonContent(header string) bool {
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
}
