package identity

import "net/http"

// allowWhileLocked is the deny-by-default whitelist of doc §4.2: the only
// method+path pairs a session with must_change_password may still reach. The
// match is exact on both halves — a prefix match here would silently widen the
// gate (for example "/api/auth/password" is not "/api/auth/password/...").
//
// The doc lists a sixth entry, "static assets / CSRF preflight". This process
// serves no static assets, and CSRF is a separate middleware mounted before
// this one (app.go), so it never reaches the gate. Both are covered by
// TestMustChangePasswordWhitelist instead of a fake path entry.
func allowWhileLocked(path, method string) bool {
	switch path {
	case "/api/auth/login":
		return method == http.MethodPost
	case "/api/auth/logout":
		return method == http.MethodPost
	case "/api/auth/session":
		return method == http.MethodGet
	case "/api/auth/password":
		return method == http.MethodPost
	case "/api/health":
		return method == http.MethodGet
	default:
		return false
	}
}

// refuseWhileLocked writes the §4.2 403 when the account is locked and the
// request is outside the whitelist. It reports whether it wrote a response.
func refuseWhileLocked(w http.ResponseWriter, r *http.Request, acc account) bool {
	if !acc.mustChangePassword || allowWhileLocked(r.URL.Path, r.Method) {
		return false
	}
	writeCloud(w, http.StatusForbidden, "PASSWORD_CHANGE_REQUIRED", msgPasswordChangeRequired)
	return true
}

func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" || (r.Header.Get("Cookie") == "" && r.Header.Get("Authorization") == "") {
			next.ServeHTTP(w, r)
			return
		}
		class := Classify(r.URL.Path, r.Method)
		_, token, acc, err := s.resolveRequest(r)
		if err != nil {
			writeCloudRetry(w, http.StatusServiceUnavailable, "服务繁忙，请稍后重试", 1)
			return
		}
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		if refuseWhileLocked(w, r, acc) {
			return
		}
		release, status, message, retry := s.admission.Admit(acc.id, class)
		if release == nil {
			writeCloudRetry(w, status, message, retry)
			return
		}
		defer release()
		next.ServeHTTP(w, r)
	})
}
