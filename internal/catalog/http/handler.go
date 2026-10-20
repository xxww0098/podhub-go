package cataloghttp

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// SellerRead posts one Seller read to a loopback origin. A nil function is
// treated as unreachable and does not dial a public host.
type SellerRead func(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, resp []byte, err error)

// Host serves catalog reads. Live fill uses Seller and only a loopback origin.
type Host struct {
	Pool   *pgxpool.Pool
	Access access.Resolver
	Now    func() time.Time
	Seller SellerRead
	Seals  seal.Ring
}

// Mount registers catalog reads.
func Mount(r chi.Router, h Host) {
	if h.Now == nil {
		h.Now = time.Now
	}
	r.Get("/api/catalog/tree", h.tree)
	r.Get("/api/catalog/schema", h.schema)
	r.Get("/api/catalog/fetch-config", h.fetchConfig)
	r.Get("/api/catalog/wb/subjects/{subject_id}", h.wbSubject)
}

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	jsonwire.Write(w, status, apiError{Error: message, Code: code})
}

func (h Host) account(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	if h.Access == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "auth_invalid")
		return access.Principal{}, false
	}
	p, refusal, err := h.Access.Resolve(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return access.Principal{}, false
	}
	if refusal != nil {
		code := "auth_invalid"
		if refusal.Status == http.StatusForbidden {
			code = "forbidden"
		}
		writeErr(w, refusal.Status, refusal.Message, code)
		return access.Principal{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "auth_invalid")
		return access.Principal{}, false
	}
	return *p, true
}

func (h Host) tree(w http.ResponseWriter, r *http.Request) {
	p, ok := h.account(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	language, ok := LanguageKey(q.Get("language"))
	if !q.Has("language") || !ok {
		writeErr(w, http.StatusBadRequest, "language 无效", "validation")
		return
	}
	storeID := strings.TrimSpace(q.Get("store_id"))
	if storeID != "" && !h.visibleStore(w, r, p, storeID) {
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	var payload []byte
	var fetched int64
	err := h.Pool.QueryRow(r.Context(), `SELECT payload, fetched_at_ms FROM public.ozon_catalog_tree_cache WHERE language = $1`, language).Scan(&payload, &fetched)
	if err == pgx.ErrNoRows {
		if storeID != "" {
			h.fillTree(w, r, p, language, storeID)
			return
		}
		jsonwire.Write(w, http.StatusOK, nil)
		return
	}
	if err != nil {
		slog.Error("catalog tree", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if !Fresh(h.Now(), fetched) {
		_, _ = h.Pool.Exec(r.Context(), `DELETE FROM public.ozon_catalog_tree_cache WHERE language = $1 AND fetched_at_ms = $2`, language, fetched)
		if storeID != "" {
			h.fillTree(w, r, p, language, storeID)
			return
		}
		jsonwire.Write(w, http.StatusOK, nil)
		return
	}
	nodes, err := DecodeTree(payload)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "类目树缓存损坏，请稍后重试", "internal")
		return
	}
	jsonwire.Write(w, http.StatusOK, &TreeData{Language: language, FetchedAtMs: fetched, Items: nodes})
}
