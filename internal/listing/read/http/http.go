package readhttp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// Host is the listing read and draft-write surface. LoadRules is the
// one-second banned-tag cache. A nil loader fails a content save closed.
type Host struct {
	Pool      *pgxpool.Pool
	Engine    Engine
	Access    access.Resolver
	Now       func() time.Time
	LoadRules func(context.Context) ([]Rule, error)
	Core      Core
	// Seller posts a Seller read. Nil records an unreadable probe and does
	// not dial. Production passes seller.Egress.Call with write=false.
	// Reads do not consult the kill switch.
	Seller SellerRead
	// Seals opens store_seller_credentials. A zero ring cannot open a key.
	Seals seal.Ring
}

// SellerRead is one loopback Seller POST. status 0 with a non-nil error
// means the round trip did not complete.
type SellerRead func(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, resp []byte, err error)

var sharedCore Core

// BindCore installs the process-wide listing-core host. A nil host leaves
// seed and edit closed.
func BindCore(core Core) { sharedCore = core }

func (h Host) core() Core {
	if h.Core != nil {
		return h.Core
	}
	return sharedCore
}

// Mount registers this domain on the router. It does not touch generated routes.
func Mount(r chi.Router, h Host) {
	if h.Now == nil {
		h.Now = time.Now
	}
	r.Get("/api/listing/cards", h.listCards)
	r.Post("/api/listing/cards", h.createCard)
	r.Get("/api/listing/cards/{id}", h.getCard)
	r.Patch("/api/listing/cards/{id}", h.patchCard)
	r.Delete("/api/listing/cards/{id}", h.deleteCard)
	r.Post("/api/listing/cards/{id}/copy", h.copyCard)
	r.Get("/api/listing/cards/{id}/snapshot", h.snapshotCard)
	r.Get("/api/listing/rows", h.listRows)
	r.Post("/api/listing/rows", h.createRow)
	r.Get("/api/listing/rows/{id}", h.getRow)
	r.Patch("/api/listing/rows/{id}", h.patchRow)
	r.Get("/api/listing/intents", h.intents)
	r.Post("/api/listing/intents/release-unknown", h.releaseUnknown)
	r.Get("/api/listing/intents/{id}", h.getIntent)
	r.Post("/api/listing/intents/{id}/cancel", h.cancelIntent)
	r.Post("/api/listing/intents/{id}/probe", h.probeIntent)
	r.Post("/api/listing/intents/{id}/recover", h.recoverIntent)
	r.Get("/api/listing/dead-letters", h.deadLetters)
	r.Post("/api/listing/dead-letters/{job_id}/requeue", h.requeueDeadLetter)
	r.Post("/api/listing/jobs/claim-window", h.claimWindow)
	r.Post("/api/listing/jobs/{id}/claim", h.claimJob)
	r.Post("/api/listing/jobs/{id}/heartbeat", h.heartbeatJob)
	r.Get("/api/listing/events", h.events)
}

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	jsonwire.Write(w, status, apiError{Error: message, Code: code})
}

func (h Host) prepare(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, ok := h.account(w, r)
	if !ok {
		return access.Principal{}, false
	}
	if status, message, allowed := access.ListingPrepare(p); !allowed {
		writeErr(w, status, message, "forbidden")
		return access.Principal{}, false
	}
	return p, true
}

func (h Host) account(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	if h.Access == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "auth_invalid")
		return access.Principal{}, false
	}
	p, refusal, err := h.Access.Resolve(r)
	if err != nil {
		slog.Error("listing access", "err", err)
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

func (h Host) withOrg(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if h.Pool == nil {
		return errors.New("database unavailable")
	}
	tx, err := tenant.BeginApp(ctx, h.Pool.Begin, orgID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, 2<<20))
}

func decode(raw []byte, dst any) error {
	dec := json.NewDecoder(bytesReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing")
	}
	return nil
}

func bytesReader(raw []byte) *jsonReader {
	return &jsonReader{raw: raw}
}

// jsonReader is an io.Reader so decode does not import bytes in a cycle.
type jsonReader struct {
	raw []byte
	at  int
}

func (r *jsonReader) Read(p []byte) (int, error) {
	if r.at >= len(r.raw) {
		return 0, io.EOF
	}
	n := copy(p, r.raw[r.at:])
	r.at += n
	return n, nil
}

func dbStatus(err error) (int, string, string) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		return http.StatusInternalServerError, access.MsgUnavailable, "internal"
	}
	if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
		return http.StatusServiceUnavailable, "资源正在更新，请稍后重试", "internal"
	}
	if errors.As(err, &pgErr) && pgErr.Code == "P0M01" {
		return http.StatusConflict, "媒体对象已进入回收，请重新上传", "internal"
	}
	slog.Error("listing db", "err", err)
	return http.StatusInternalServerError, access.MsgUnavailable, "internal"
}

func queryID(r *http.Request) (string, bool) {
	return CanonicalUUID(chi.URLParam(r, "id"))
}

func notWritten(w http.ResponseWriter) {
	writeErr(w, http.StatusNotImplemented, ErrNotWritten.Error(), "not_ported")
}
