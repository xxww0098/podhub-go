package cataloghttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/catalog/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// SellerRead posts one allowed Seller read through the assembly. A nil
// function is treated as unreachable.
type SellerRead func(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, resp []byte, err error)

// Host serves catalog reads. Live fill uses the dedicated Seller read port.
type Host struct {
	Pool   *pgxpool.Pool
	Access access.Resolver
	Now    func() time.Time
	Seller SellerRead
	Seals  seal.Ring
	// Snapshot is the canonical listing snapshot supplied by the assembly.
	Snapshot   func(context.Context, []byte) ([]byte, error)
	Fetcher    *service.Fetcher
	fetchLease *service.FetchClaim
}

// readIn runs one read inside an application session.
//
// h.Pool on its own holds podhub_login_api connections, and that role is
// NOINHERIT with zero table grants (00001_roles.sql): the GRANT podhub_app TO
// podhub_login_api only takes effect after SET ROLE. A bare h.Pool.Query
// therefore fails with "permission denied for table sc_*" rather than
// returning no rows. Every catalog read that touches a table must go through
// here.
//
// The catalog tables are platform-wide reference data, so this is AppRole
// with org 0: the policies that matter for them are the published/listed
// arms, not an org arm.
func (h Host) readIn(ctx context.Context, fn func(pgx.Tx) error) error {
	if h.Pool == nil {
		return errNoPool
	}
	return db.InTx(ctx, h.Pool, db.AppRole(), func(tx pgx.Tx) error {
		if h.fetchLease != nil {
			defer writer.Forget(tx)
			if err := service.AssertFetchClaim(ctx, tx, *h.fetchLease, h.Now()); err != nil {
				return err
			}
		}
		return fn(tx)
	})
}

// queryRow, query and exec are the session-wrapped forms of the pgxpool
// methods, so a handler never has to remember to open an app session. Each
// call is its own short transaction; the catalog reads are single-statement
// lookups, not multi-statement units of work.
// queryOne scans one row inside a single app session. It cannot return a
// pgx.Row: the row is bound to the transaction that produced it, and readIn
// closes that transaction before the caller could Scan it. So the scan
// happens here, and a missing row surfaces as pgx.ErrNoRows exactly as a bare
// QueryRow would.
func (h Host) queryOne(ctx context.Context, sql string, argsAndDest ...any) error {
	if h.Pool == nil {
		return errNoPool
	}
	// The last argument is always the []any of scan targets; everything before
	// it is a query parameter. Keeping one variadic list lets the call sites
	// read like the pgxpool ones they replaced.
	n := len(argsAndDest)
	if n == 0 {
		return errNoPool
	}
	dest, ok := argsAndDest[n-1].([]any)
	if !ok {
		return errNoPool
	}
	args := argsAndDest[:n-1]
	return h.readIn(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, sql, args...).Scan(dest...)
	})
}

func (h Host) exec(ctx context.Context, sql string, args ...any) (int64, error) {
	var n int64
	err := h.readIn(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, sql, args...)
		n = tag.RowsAffected()
		return e
	})
	return n, err
}

// errRow makes a nil-pool Host behave like a failed query instead of panicking.
type errRow struct{ err error }

func (r errRow) Scan(dest ...any) error { return r.err }

// errNoPool keeps the old nil-pool 500 path distinct from a query error.
var errNoPool = errors.New("catalog: no database pool")

// Mount registers catalog reads.
func Mount(r chi.Router, h Host) {
	if h.Now == nil {
		h.Now = time.Now
	}
	r.Get("/api/catalog/tree", h.tree)
	r.Get("/api/catalog/schema", h.schema)
	r.Post("/api/catalog/schema/dictionary-search", h.searchDictionary)
	r.Get("/api/admin/catalog/fetch-config", h.fetchConfig)
	r.Put("/api/admin/catalog/fetch-config", h.saveFetchConfig)
	r.Post("/api/admin/catalog/fetch-config/run", h.runFetch)
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
	err := h.queryOne(r.Context(), `SELECT payload, fetched_at_ms FROM public.ozon_catalog_tree_cache WHERE language = $1`, language, []any{&payload, &fetched})
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
		_, _ = h.exec(r.Context(), `DELETE FROM public.ozon_catalog_tree_cache WHERE language = $1 AND fetched_at_ms = $2`, language, fetched)
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
