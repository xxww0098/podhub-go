package agenthttp

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// errBody is AgentErrorResponse. Field order is error, then code.
type errBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeOK(w http.ResponseWriter, payload any) {
	raw, err := jsonwire.Marshal(payload)
	if err != nil {
		slog.Error("agent json", "err", err)
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL", "")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(raw); err != nil {
		slog.Error("agent write", "err", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg, code, retryAfter string) {
	raw, err := jsonwire.Marshal(errBody{Error: msg, Code: code})
	if err != nil {
		slog.Error("agent json", "err", err)
		http.Error(w, "服务暂不可用", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	w.WriteHeader(status)
	if _, err := w.Write(raw); err != nil {
		slog.Error("agent write", "err", err)
	}
}

func writeFailure(w http.ResponseWriter, err error) {
	var failure *contract.Failure
	if !errors.As(err, &failure) || failure == nil {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL", "")
		return
	}
	msg := failure.Msg
	if msg == "" {
		msg = "服务暂不可用"
	}
	switch failure.Kind {
	case contract.KindUnauth:
		writeErr(w, http.StatusUnauthorized, msg, "AUTH_REQUIRED", "")
	case contract.KindValidation:
		writeErr(w, http.StatusBadRequest, msg, "VALIDATION", "")
	case contract.KindNotFound:
		writeErr(w, http.StatusNotFound, msg, "NOT_FOUND", "")
	case contract.KindConflict:
		writeErr(w, http.StatusConflict, msg, "CONFLICT", "")
	case contract.KindBusy:
		writeErr(w, http.StatusServiceUnavailable, msg, "INTERNAL", failure.RetryAfter)
	case contract.KindMedia:
		writeErr(w, http.StatusConflict, msg, "INTERNAL", "")
	case contract.KindDisabled:
		writeErr(w, http.StatusServiceUnavailable, msg, "INTERNAL", "")
	default:
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL", "")
	}
}
