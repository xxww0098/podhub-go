package identity

import (
	"net/http"
	"strings"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

const (
	maxStackedSessions  = 8
	sessionCookieMaxAge = 604800
	stackDelimiter      = "."
)

// Credentials is the session material on one request. Bearer wins over sid.
type Credentials struct {
	Bearer string
	SID    string
	Stack  []string
}

func (c Credentials) Presented() string {
	if c.Bearer != "" {
		return c.Bearer
	}
	return c.SID
}

func (c Credentials) Candidates() []string {
	var tokens []string
	push := func(token string) {
		if token == "" {
			return
		}
		for _, held := range tokens {
			if held == token {
				return
			}
		}
		tokens = append(tokens, token)
	}
	push(c.Presented())
	for _, token := range c.Stack {
		push(token)
	}
	return tokens
}

func (c Credentials) StackCandidates() []string {
	tokens := append([]string{}, c.Stack...)
	presented := c.Presented()
	if presented == "" {
		return tokens
	}
	for _, held := range tokens {
		if held == presented {
			return tokens
		}
	}
	return append(tokens, presented)
}

// SessionCredentials reads Bearer, sid, and sids.
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
		switch name {
		case SessionCookie:
			if IsSessionToken(value) {
				cred.SID = value
			}
		case StackCookie:
			cred.Stack = parseStack(value)
		}
	}
	return cred
}

func parseStack(value string) []string {
	var tokens []string
	for _, token := range strings.Split(value, stackDelimiter) {
		if !IsSessionToken(token) {
			continue
		}
		dup := false
		for _, held := range tokens {
			if held == token {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		tokens = append(tokens, token)
		if len(tokens) >= maxStackedSessions {
			break
		}
	}
	return tokens
}

// IsSessionToken reports a 43-character base64url token.
func IsSessionToken(token string) bool {
	if len(token) != 43 {
		return false
	}
	for i := 0; i < len(token); i++ {
		b := token[i]
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '-' || b == '_' {
			continue
		}
		return false
	}
	return true
}

// MergedStack drops the same account, appends the new token, and evicts the oldest past 8.
func MergedStack(resolved []StackEntry, newUserID int64, newToken string) []string {
	stack := make([]string, 0, len(resolved)+1)
	for _, entry := range resolved {
		if entry.UserID == newUserID || entry.Token == newToken {
			continue
		}
		stack = append(stack, entry.Token)
	}
	stack = append(stack, newToken)
	if len(stack) > maxStackedSessions {
		stack = stack[len(stack)-maxStackedSessions:]
	}
	return stack
}

// StackEntry is one live stacked session.
type StackEntry struct {
	Token  string
	UserID int64
}

// AfterRevoke promotes the newest remaining session when sid was removed.
func AfterRevoke(cred Credentials, removed []string) (string, []string) {
	stack := make([]string, 0, len(cred.Stack))
	for _, token := range cred.Stack {
		if containsToken(removed, token) {
			continue
		}
		stack = append(stack, token)
	}
	sid := cred.SID
	if sid != "" && containsToken(removed, sid) {
		sid = ""
		if len(stack) > 0 {
			sid = stack[len(stack)-1]
		}
	}
	if sid == "" {
		return "", stack
	}
	if !containsToken(stack, sid) {
		stack = append(stack, sid)
	}
	return sid, stack
}

func containsToken(tokens []string, token string) bool {
	for _, held := range tokens {
		if held == token {
			return true
		}
	}
	return false
}

// CookieSecureAttribute is "; Secure" unless CLOUD_COOKIE_SECURE is 0 or false after trim.
func CookieSecureAttribute() string { return config.CookieSecureAttribute() }

// SessionCookies republishes sid and sids together.
func SessionCookies(sid string, stack []string) []string {
	secure := CookieSecureAttribute()
	maxAge := itoa(int64(sessionCookieMaxAge))
	sidCookie := SessionCookie + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + secure
	if sid != "" {
		sidCookie = SessionCookie + "=" + sid + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; SameSite=Lax" + secure
	}
	stackCookie := StackCookie + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + secure
	if len(stack) > 0 {
		stackCookie = StackCookie + "=" + strings.Join(stack, stackDelimiter) + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; SameSite=Lax" + secure
	}
	return []string{sidCookie, stackCookie}
}
