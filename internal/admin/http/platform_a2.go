package adminhttp

import (
	"net/http"
	"strings"
)

// platformA2 handles the admin platform routes this port owns. Supplier
// routes stay on the generic guard.
func (h handler) platformA2(w http.ResponseWriter, r *http.Request, rt Route, s Session) bool {
	switch {
	case strings.HasPrefix(rt.Path, "/api/admin/platform-catalog"):
		h.catalog(w, r, rt, s)
	case strings.HasPrefix(rt.Path, "/api/admin/agent"):
		h.agents(w, r, rt, s)
	case strings.HasPrefix(rt.Path, "/api/admin/seller-relay"):
		h.relay(w, r, rt, s)
	case strings.HasPrefix(rt.Path, "/api/admin/delegate-orders"):
		h.delegateAdmin(w, r, rt, s)
	default:
		return false
	}
	return true
}
