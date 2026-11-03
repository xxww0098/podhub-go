package identity

import (
	"net/http"
	"strings"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	sessionCookieMaxAge = 604800
)

// Credentials is the session material on one request. Bearer wins over sid.
// One browser holds one account: there is no session stack to choose from.
type Credentials struct {
	Bearer string
	SID    string
}

func (c Credentials) Presented() string {
	if c.Bearer != "" {
		return c.Bearer
	}
	return c.SID
}

// SessionCredentials reads Bearer and sid. A leftover `sids` cookie from the
// retired multi-account stack is ignored and overwritten by the next reply.
func SessionCredentials(h http.Header) Credentials {
	var cred Credentials
	if auth := h.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		if token != "" {
			cred.Bearer = token
		}
	}
	for _, part := range strings.Split(h.Get("Cookie"), ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		if name == SessionCookie && IsSessionToken(value) {
			cred.SID = value
		}
	}
	return cred
}

// IsSessionToken reports a 43-character base64url token.
func IsSessionToken(token string) bool {
	if len(token) != 43 {
		return false
	}
	for i := range len(token) {
		b := token[i]
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '-' || b == '_' {
			continue
		}
		return false
	}
	return true
}

// CookieSecureAttribute is "; Secure" unless CLOUD_COOKIE_SECURE is 0 or false after trim.
func CookieSecureAttribute() string { return config.CookieSecureAttribute() }

// SessionCookies sets sid, or clears it when sid is empty. The retired `sids`
// cookie is expired on every reply so an old browser drops it.
func SessionCookies(sid string) []string {
	secure := CookieSecureAttribute()
	sidCookie := SessionCookie + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + secure
	if sid != "" {
		sidCookie = SessionCookie + "=" + sid + "; Path=/; Max-Age=" + itoa(int64(sessionCookieMaxAge)) + "; HttpOnly; SameSite=Lax" + secure
	}
	return []string{sidCookie, retiredStackCookie(secure)}
}

func retiredStackCookie(secure string) string {
	return "sids=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + secure
}
