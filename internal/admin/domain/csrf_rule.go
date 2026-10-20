package domain

import "strings"

// CrossOriginWrite is the cookie write CSRF check. Both site and origin empty is allowed.
func CrossOriginWrite(method, cookie, site, origin, host string) bool {
	switch method {
	case "POST", "PUT", "PATCH", "DELETE":
	default:
		return false
	}
	if !sessionCookie(cookie) {
		return false
	}
	if strings.TrimSpace(site) != "" {
		switch strings.TrimSpace(site) {
		case "same-origin", "none":
			return false
		default:
			return true
		}
	}
	if origin == "" {
		return false
	}
	auth, ok := originAuthority(origin)
	if !ok || strings.TrimSpace(host) == "" {
		return true
	}
	return auth != strings.TrimSpace(host)
}

func sessionCookie(cookies string) bool {
	for _, part := range strings.Split(cookies, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if (name == "sid" || name == "sids") && value != "" {
			return true
		}
	}
	return false
}

func originAuthority(origin string) (string, bool) {
	scheme, rest, ok := strings.Cut(origin, "://")
	if !ok || scheme == "" || rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}
