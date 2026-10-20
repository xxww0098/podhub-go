package adminhttp

import (
	"io"
	"net/http"
	"reflect"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// gateSuper is the admin write-gate ladder: signed in, super admin, TOTP
// enrolled, and step-up elevated. The status triple is writeShippingErr's.
func gateSuper(s Session) (int, string, string) {
	if s.UserID == 0 {
		return http.StatusUnauthorized, "未登录", "AUTH_INVALID"
	}
	if !strings.EqualFold(strings.TrimSpace(s.PlatformRole), "super_admin") {
		return http.StatusForbidden, "需要超级管理员权限", "FORBIDDEN"
	}
	if !sessionBool(s, "TotpEnrolled") {
		return http.StatusForbidden, "请先绑定验证器", "FORBIDDEN"
	}
	if !sessionBool(s, "StepUpElevated") {
		return http.StatusForbidden, "管理操作需要重新验证", "FORBIDDEN"
	}
	return 0, "", ""
}

func sessionBool(s Session, name string) bool {
	f := reflect.ValueOf(s).FieldByName(name)
	return f.IsValid() && f.Kind() == reflect.Bool && f.Bool()
}

func sessionString(s Session, name string) string {
	f := reflect.ValueOf(s).FieldByName(name)
	if !f.IsValid() || f.Kind() != reflect.String {
		return ""
	}
	return f.String()
}

// depPtr reads one optional service pointer off Deps by field name. A nil or
// missing dependency leaves the route on the 501 path.
func depPtr[T any](d Deps, name string) *T {
	f := reflect.ValueOf(d).FieldByName(name)
	if !f.IsValid() || f.IsZero() {
		return nil
	}
	p, ok := f.Interface().(*T)
	if !ok {
		return nil
	}
	return p
}

// rawBody reads the request body for the service calls that take raw JSON.
func rawBody(r *http.Request) []byte {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024))
	return body
}

func writeShippingErr(w http.ResponseWriter, status int, message, code string) {
	raw, err := domain.Marshal(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: message, Code: code})
	if err != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// writeShippingAPI maps one domain failure onto the error envelope.
func writeShippingAPI(w http.ResponseWriter, err error) {
	if ae, ok := err.(*domain.APIError); ok {
		code := ae.Code
		if code == "" {
			code = "INTERNAL"
		}
		st := ae.Status
		if st == 0 {
			st = http.StatusInternalServerError
		}
		writeShippingErr(w, st, ae.Message, code)
		return
	}
	writeShippingErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL")
}

func writeShippingResult(w http.ResponseWriter, status int, body any, err error) {
	if err != nil {
		writeShippingAPI(w, err)
		return
	}
	raw, err := domain.Marshal(body)
	if err != nil {
		writeShippingErr(w, http.StatusInternalServerError, "服务暂不可用", "INTERNAL")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
