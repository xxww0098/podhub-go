// Package domain checks MCP host, origin, and bearer shape, and builds the
// authorized catalog. Host and origin rules follow rmcp DNS-rebinding checks
// described in spec-aomt-mcp section 2.4.
package domain

import (
	"net/url"
	"strings"

	"github.com/xxww0098/podhub-go/internal/mcp/contract"
)

// Allow is the parsed MCP config the HTTP layer receives. An empty host
// list keeps the loopback defaults. An empty origin list does not check Origin.
type Allow struct {
	Hosts   []string
	Origins []string
}

// CheckHost returns 400 or 403 and a plain-text body, or 0 when the host is allowed.
func (a Allow) CheckHost(host string) (int, string) {
	host = strings.TrimSpace(host)
	if host == "" {
		return 400, "Bad Request: missing Host header"
	}
	name, port, ok := splitHost(host)
	if !ok || name == "" {
		return 400, "Bad Request: Invalid Host header"
	}
	hosts := a.Hosts
	if len(hosts) == 0 {
		hosts = []string{"localhost", "127.0.0.1", "::1"}
	}
	for _, item := range hosts {
		allowName, allowPort, ok := splitHost(item)
		if !ok {
			continue
		}
		if !strings.EqualFold(allowName, name) {
			continue
		}
		if allowPort == "" || allowPort == port {
			return 0, ""
		}
	}
	return 403, "Forbidden: Host header is not allowed"
}

// CheckOrigin returns 400 or 403, or 0 when the origin is allowed.
// An empty allow-list skips the check. A missing Origin passes.
func (a Allow) CheckOrigin(origin string) (int, string) {
	if len(a.Origins) == 0 || strings.TrimSpace(origin) == "" {
		return 0, ""
	}
	got, err := url.Parse(origin)
	if err != nil || got.Scheme == "" || got.Host == "" {
		return 400, "Bad Request: Invalid Origin header"
	}
	for _, item := range a.Origins {
		want, err := url.Parse(strings.TrimSpace(item))
		if err != nil || want.Scheme == "" || want.Host == "" {
			continue
		}
		if !strings.EqualFold(want.Scheme, got.Scheme) || !strings.EqualFold(want.Hostname(), got.Hostname()) {
			continue
		}
		if want.Port() == "" || want.Port() == got.Port() {
			return 0, ""
		}
	}
	return 403, "Forbidden: Origin header is not allowed"
}

// HostOK reports whether CheckHost accepts the value.
func (a Allow) HostOK(host string) bool {
	code, _ := a.CheckHost(host)
	return code == 0
}

// OriginOK reports whether CheckOrigin accepts the value.
func (a Allow) OriginOK(origin string) bool {
	code, _ := a.CheckOrigin(origin)
	return code == 0
}

func splitHost(h string) (name, port string, ok bool) {
	h = strings.TrimSpace(h)
	if h == "" {
		return "", "", false
	}
	if strings.HasPrefix(h, "[") {
		end := strings.IndexByte(h, ']')
		if end <= 1 {
			return "", "", false
		}
		name = h[1:end]
		rest := h[end+1:]
		if rest == "" {
			return name, "", name != ""
		}
		if !strings.HasPrefix(rest, ":") || rest == ":" {
			return "", "", false
		}
		return name, rest[1:], true
	}
	if strings.Count(h, ":") > 1 {
		return h, "", true
	}
	if i := strings.LastIndexByte(h, ':'); i >= 0 {
		if i == 0 || i == len(h)-1 {
			return "", "", false
		}
		return h[:i], h[i+1:], true
	}
	return h, "", true
}

// BearerToken accepts "Bearer opa_..." with a non-empty suffix.
func BearerToken(header string) (string, error) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", contract.ErrBearerDenied
	}
	token := strings.TrimSpace(header[len(prefix):])
	if !strings.HasPrefix(token, "opa_") || len(token) <= len("opa_") {
		return "", contract.ErrBearerDenied
	}
	if strings.ContainsAny(token, " \t\r\n") {
		return "", contract.ErrBearerDenied
	}
	return token, nil
}
