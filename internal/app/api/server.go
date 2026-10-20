package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// RulesSource loads enabled banned-tag rules. A nil source with a nil pool
// fails closed. Tests supply a fixed list; the process uses the database.
type RulesSource interface {
	EnabledBannedTags(context.Context) ([]listing.Rule, error)
}

// Server serves the generated HTTP contract. A nil pool answers 503 for health
// and for listing rule reads, and 500 for the read endpoints that need
// PostgreSQL. Engine nil fails a tag check closed.
//
// Access is the session seam. PR-1 owns cookies, sessions, and TOTP step-up.
// A nil Access, a nil principal, or a refusal is logged out or rejected here;
// this package does not read a cookie. Now overrides the clock; nil is time.Now.
type Server struct {
	Pool     *pgxpool.Pool
	Engine   listing.Engine
	Rules    RulesSource
	Access   access.Resolver
	Identity *identity.Service
	Now      func() time.Time
	// Media signs browser PUTs. Nil, or any endpoint that is not 127.0.0.1,
	// refuses the route. The process does not sign a real bucket.
	Media *sign.Account
	// Workspace overrides the organizations.uuid lookup. Nil reads it inside
	// a podhub_app transaction for the session org.
	Workspace func(ctx context.Context, orgID int64) (string, error)
	// Seller is one Seller read. Production passes seller.Egress.Call with
	// write=false. The kill switch is the bool already captured by seller.New.
	Seller func(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, resp []byte, err error)
	// Seals opens store and platform catalog envelopes.
	Seals seal.Ring
	// OpenGrant decrypts one store envelope on the browser grant route.
	// Nil uses Seals. The opened secret is not logged.
	OpenGrant func(seal.Store) (seal.Secret, error)
	// WritesDisabled is the kill switch captured when this server was built.
	// The grant route reads this bool and does not load configuration again.
	WritesDisabled bool
	// Ozon records redacted import/info and request-layer errors. Nil skips
	// that recording. The grant route does not read this field.
	Ozon OzonRecorder
}

func (s *Server) GetHealth(w http.ResponseWriter, r *http.Request) {
	ok := s.available(r.Context())
	status := http.StatusOK
	dbStatus := Available
	if !ok {
		status = http.StatusServiceUnavailable
		dbStatus = Unavailable
	}
	body := healthWire{
		Ok:           ok,
		Db:           dbStatus,
		Ts:           time.Now().UnixMilli(),
		WriterLeases: []WriterLeaseHealth{},
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	// The health body has no trailing newline. Encoder.Encode appends one,
	// and that extra byte fails the health golden.
	raw, err := json.Marshal(body)
	if err != nil {
		slog.Error("health encode", "err", err)
		return
	}
	if _, err := w.Write(raw); err != nil {
		slog.Error("health write", "err", err)
	}
}

// healthWire fixes the health field order: ok, db, ts, writer_leases.
// The generated struct sorts keys differently.
type healthWire struct {
	Ok           bool                `json:"ok"`
	Db           DatabaseStatus      `json:"db"`
	Ts           int64               `json:"ts"`
	WriterLeases []WriterLeaseHealth `json:"writer_leases"`
}

func (s *Server) identity() *identity.Service {
	if s.Identity != nil {
		return s.Identity
	}
	return identity.New(s.Pool)
}

func (s *Server) PostAuthRegister(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Register(r))
}
func (s *Server) PostAuthLogin(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Login(r))
}
func (s *Server) PostAuthLogout(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Logout(r))
}
func (s *Server) PostAuthSwitch(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().SwitchAccount(r))
}
func (s *Server) PostAuthPassword(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Password(r))
}
func (s *Server) PostAuthForgot(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Forgot(r))
}
func (s *Server) PostAuthReset(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Reset(r))
}
func (s *Server) PostAuthVerify(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Verify(r))
}
func (s *Server) PostAuthVerifyResend(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().VerifyResend(r))
}
func (s *Server) GetAuthSession(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Session(r))
}
func (s *Server) PutAuthName(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Rename(r))
}
func (s *Server) DeleteAuthAccount(w http.ResponseWriter, r *http.Request, uuid string) {
	identity.WriteResult(w, s.identity().DeleteAccount(r, uuid))
}
func (s *Server) GetWorkspaceMembers(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Members(r))
}
func (s *Server) PostWorkspaceSwitch(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().SwitchWorkspace(r))
}

func (s *Server) available(ctx context.Context) bool {
	if s == nil || s.Pool == nil {
		return false
	}
	n, err := sqlc.New(s.Pool).DatabaseOne(ctx)
	return err == nil && n == 1
}
