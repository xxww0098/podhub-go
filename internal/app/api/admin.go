package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	rules "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

const (
	adminBodyLimit   int64 = 2 * 1024 * 1024
	confirmBodyLimit int64 = 65536
	adminDeadline          = 30 * time.Second
	confirmDeadline        = 3900 * time.Second
)

// adminHost serves the ported admin B routes.
type adminHost struct {
	access access.Resolver
	deps   service.Deps
}

// AdminPorted returns the handlers that replace 501 for listing packages,
// prompts, videos, and media admin. Keys are "METHOD path".
func AdminPorted(s *Server, accounts func(context.Context) ([]domain.CloudAccount, error)) map[string]http.HandlerFunc {
	if s == nil {
		return nil
	}
	now := s.Now
	h := &adminHost{
		access: s.Access,
		deps: service.Deps{
			Pool: s.Pool, Now: now, Holder: "axum", Instance: writerInstance(),
			Accounts: accounts, Engine: s.Engine, BannedTags: rules.EnabledBannedTags,
			Origin: originCaller{}, Tickets: adminTickets{},
		},
	}
	return map[string]http.HandlerFunc{
		"GET /api/admin/listing/packages/official":  h.getPackage,
		"POST /api/admin/listing/packages/official": h.createPackage,
		"POST /api/admin/prompts":                   h.createPrompt,
		"PUT /api/admin/prompts/{prompt_id}":        h.updatePrompt,
		"DELETE /api/admin/prompts/{prompt_id}":     h.deletePrompt,
		"POST /api/admin/videos":                    h.createVideo,
		"PUT /api/admin/videos/{video_id}":          h.updateVideo,
		"DELETE /api/admin/videos/{video_id}":       h.deleteVideo,
		"GET /api/admin/media/storage":              h.storage,
		"POST /api/admin/media/purge":               h.purge,
		"GET /api/admin/media/objects":              h.listObjects,
		"POST /api/admin/media/directories":         h.createDirectory,
		"POST /api/admin/media/uploads":             h.presign,
		"POST /api/admin/media/uploads/confirm":     h.confirm,
		"POST /api/admin/media/objects/move":        h.moveObject,
		"POST /api/admin/media/objects/delete":      h.deleteObjects,
	}
}

func writerInstance() string {
	return config.Load().WriterInstanceID()
}

func (h *adminHost) admit(w http.ResponseWriter, r *http.Request) (service.Actor, bool) {
	if h.access == nil {
		writeFail(w, service.NewFail(http.StatusUnauthorized, "AUTH_INVALID", "未登录"))
		return service.Actor{}, false
	}
	principal, refusal, err := h.access.Resolve(r)
	if err != nil {
		writeFail(w, asFail(service.MapDatabase(err, http.StatusInternalServerError, "INTERNAL", "服务暂不可用")))
		return service.Actor{}, false
	}
	if refusal != nil {
		code := "AUTH_INVALID"
		if refusal.Status == http.StatusForbidden {
			code = "FORBIDDEN"
		} else if refusal.Status != http.StatusUnauthorized {
			code = "INTERNAL"
		}
		writeFail(w, service.NewFail(refusal.Status, code, refusal.Message))
		return service.Actor{}, false
	}
	if principal == nil {
		writeFail(w, service.NewFail(http.StatusUnauthorized, "AUTH_INVALID", "未登录"))
		return service.Actor{}, false
	}
	if !access.IsSuperAdmin(principal.PlatformRole) {
		writeFail(w, service.NewFail(http.StatusForbidden, "FORBIDDEN", "需要超级管理员权限"))
		return service.Actor{}, false
	}
	return service.Actor{UserID: principal.UserID, OrgID: principal.OrgID}, true
}

func (h *adminHost) ctx(w http.ResponseWriter, r *http.Request, limit time.Duration) (context.Context, context.CancelFunc, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), limit)
	return ctx, cancel, true
}

func finish(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, context.DeadlineExceeded) {
		writeCloud(w, http.StatusGatewayTimeout, "internal", "请求处理超时")
		return false
	}
	writeFail(w, asFail(err))
	return false
}

func asFail(err error) *service.Fail {
	if f, ok := service.AsFail(err); ok {
		return f
	}
	return service.NewFail(http.StatusInternalServerError, "INTERNAL", "服务暂不可用")
}

func writeFail(w http.ResponseWriter, f *service.Fail) {
	if f == nil {
		f = service.NewFail(http.StatusInternalServerError, "INTERNAL", "服务暂不可用")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if f.RetryAfter != "" {
		w.Header().Set("Retry-After", f.RetryAfter)
	}
	raw, err := jsonwire.Marshal(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{f.Message, f.Code})
	if err != nil {
		http.Error(w, "服务暂不可用", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(f.Status)
	_, _ = w.Write(raw)
}

func writeCloud(w http.ResponseWriter, status int, code, message string) {
	raw, err := jsonwire.Marshal(struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{code, message})
	if err != nil {
		http.Error(w, "服务暂不可用", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func readJSON(w http.ResponseWriter, r *http.Request, limit int64) (map[string]json.RawMessage, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	raw, err := io.ReadAll(r.Body)
	var max *http.MaxBytesError
	if errors.As(err, &max) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return nil, false
	}
	if err != nil || len(bytes.TrimSpace(raw)) == 0 {
		writeFail(w, service.NewFail(http.StatusBadRequest, "VALIDATION", "请求格式无效"))
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if dec.Decode(&fields) != nil || dec.More() || fields == nil {
		writeFail(w, service.NewFail(http.StatusBadRequest, "VALIDATION", "请求格式无效"))
		return nil, false
	}
	return fields, true
}

func known(fields map[string]json.RawMessage, keys ...string) bool {
	allow := map[string]struct{}{}
	for _, key := range keys {
		allow[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := allow[key]; !ok {
			return false
		}
	}
	return true
}

func strField(fields map[string]json.RawMessage, key string, required bool, fallback string) (string, bool) {
	raw, ok := fields[key]
	if !ok {
		if required {
			return "", false
		}
		return fallback, true
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func intField(fields map[string]json.RawMessage, key string) (int64, bool) {
	raw, ok := fields[key]
	if !ok {
		return 0, false
	}
	var value int64
	if json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	return value, true
}

func tagsField(fields map[string]json.RawMessage) ([]string, bool) {
	raw, ok := fields["fixedTags"]
	if !ok {
		return []string{}, true
	}
	var tags []string
	if json.Unmarshal(raw, &tags) != nil || tags == nil {
		return nil, false
	}
	return tags, true
}

func badRequest(w http.ResponseWriter) {
	writeFail(w, service.NewFail(http.StatusBadRequest, "VALIDATION", "请求格式无效"))
}
