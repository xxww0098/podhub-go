package identity

import (
	"net/http"
	"strings"
)

const (
	SessionCookie = "sid"
	StackCookie   = "sids"
)

// CrossOriginWrite reports a cookie-authenticated write that is not same-origin.
// Reads, and writes with no sid or sids cookie, are allowed. A missing
// Sec-Fetch-Site and Origin is a non-browser client and is allowed.
func CrossOriginWrite(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	if !carriesSessionCookie(r.Header.Get("Cookie")) {
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		switch strings.TrimSpace(site) {
		case "same-origin", "none":
			return false
		default:
			return true
		}
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	auth, ok := originAuthority(origin)
	if !ok {
		return true
	}
	host := strings.TrimSpace(r.Host)
	if host == "" {
		host = strings.TrimSpace(r.Header.Get("Host"))
	}
	if host == "" {
		return true
	}
	return auth != host
}

func originAuthority(origin string) (string, bool) {
	scheme, rest, ok := strings.Cut(origin, "://")
	if !ok || scheme == "" || rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func carriesSessionCookie(cookies string) bool {
	if cookies == "" {
		return false
	}
	for _, part := range strings.Split(cookies, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if (name == SessionCookie || name == StackCookie) && value != "" {
			return true
		}
	}
	return false
}

// CSRF rejects a cross-origin cookie write before the handler runs.
func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if CrossOriginWrite(r) {
			writeCloud(w, http.StatusForbidden, "csrf_rejected", "跨站请求已被拒绝")
			return
		}
		next.ServeHTTP(w, r)
	})
}
