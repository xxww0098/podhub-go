package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/catalog"
	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
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
// Access is the session seam. PR-1 owns cookies and sessions.
// A nil Access, a nil principal, or a refusal is logged out or rejected here;
// this package does not read a cookie. Now overrides the clock; nil is time.Now.
type Server struct {
	Listing                 submit.Service
	ListingPreparationQueue listing.MediaQueue
	ListingTaskRecords      listing.TaskRecordReader
	RecognitionModels       func(context.Context) ([]string, string, error)
	Pool                    *pgxpool.Pool
	Engine                  listing.Engine
	Rules                   RulesSource
	Access                  access.Resolver
	Identity                *identity.Service
	Now                     func() time.Time
	// Media may supply a test account; production loads the workspace's encrypted configuration.
	Media                func(context.Context, access.Principal) (*sign.Account, error)
	SupplierMediaAccount func(context.Context) (sign.Account, error)
	SliceStorageKey      []byte
	SliceDeleteAllowed   bool
	Cloudflare           *cloudflare.Client
	CloudflareOAuth      cloudflare.OAuth
	// VerifySlice overrides the real upload/read/delete probe in isolated tests.
	VerifySlice func(context.Context, sign.Account, string, string) (bool, error)
	// Workspace overrides the organizations.uuid lookup. Nil reads it inside
	// a podhub_app transaction for the session org.
	Workspace func(ctx context.Context, orgID int64) (string, error)
	// Seller is one allowed Seller read. Production passes the dedicated
	// fixed-host read port; the write kill switch does not block reads.
	Seller func(ctx context.Context, path string, body []byte, clientID, apiKey string) (status int, resp []byte, err error)
	// CatalogSnapshot uses the same canonical builder as listing row creation.
	CatalogSnapshot func(context.Context, []byte) ([]byte, error)
	CatalogFetch    *catalog.Fetcher
	// Seals opens store and platform catalog envelopes.
	Seals seal.Ring
	// OpenGrant decrypts one store envelope on the browser grant route.
	// Nil uses Seals. The opened secret is not logged.
	OpenGrant func(seal.Store) (seal.Secret, error)
	// WritesDisabled is the kill switch captured when this server was built.
	// The grant route reads this bool and does not load configuration again.
	WritesDisabled bool
	// PublicURL is the externally reachable origin used in direct-upload
	// grants. Empty falls back to the request authority.
	PublicURL string
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
	leases := []WriterLeaseHealth{}
	if ok {
		statuses, err := writer.ReadStatus(r.Context(), s.Pool, writer.Domains())
		if err != nil {
			slog.Error("health writer leases", "err", err)
		} else {
			for _, st := range statuses {
				item := WriterLeaseHealth{Domain: st.Domain}
				if st.Present {
					holder, instance := st.Holder, st.Instance
					fence, expires, beat := st.FenceToken, st.ExpiresAtMS, st.HeartbeatMS
					item.Holder = &holder
					item.HolderInstance = &instance
					item.FenceToken = &fence
					item.ExpiresAtMs = &expires
					item.HeartbeatAtMs = &beat
				}
				leases = append(leases, item)
			}
		}
	}
	body := healthWire{
		Ok:           ok,
		Db:           dbStatus,
		Ts:           time.Now().UnixMilli(),
		WriterLeases: leases,
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
func (s *Server) PostAuthPassword(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Password(r))
}
func (s *Server) PostAuthForgot(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Forgot(r))
}
func (s *Server) PostAuthEmailChange(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().RequestEmailChange(r))
}
func (s *Server) PostAuthEmailConfirm(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().ConfirmEmailChange(r))
}
func (s *Server) PostAuthReset(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Reset(r))
}
func (s *Server) GetAuthSession(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Session(r))
}
func (s *Server) PutAuthName(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().Rename(r))
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

func (s *Server) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().CreateWorkspace(r))
}
