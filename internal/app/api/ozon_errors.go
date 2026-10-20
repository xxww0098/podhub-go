package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ozonerr/contract"
	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
)

// OzonRecorder stores redacted Seller error observations. A nil recorder
// skips recording. It does not issue credentials and it does not read the
// write switch.
type OzonRecorder interface {
	RecordRows(ctx context.Context, orgID int64, rows []domain.Row) (int, error)
	RecordRequest(ctx context.Context, orgID int64, in domain.RequestError) error
	ListOrg(ctx context.Context, orgID int64, rawQuery string) ([]byte, error)
	List(ctx context.Context, userID int64, rawQuery string) ([]byte, error)
	ObserveUpstream(ctx context.Context, orgID int64, status int, requestBody, responseBody []byte) error
}

func (s *Server) postBrowserImportInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, ok := s.submitActor(w, r)
	if !ok {
		return
	}
	if s == nil || s.Ozon == nil {
		writeListing(w, http.StatusServiceUnavailable, "服务暂不可用", "internal")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeListing(w, http.StatusBadRequest, "请求无效", "bad_request")
		return
	}
	rows, err := domain.ParseImportBody(body)
	if err != nil {
		writeListing(w, http.StatusBadRequest, "请求无效", "bad_request")
		return
	}
	n, err := s.Ozon.RecordRows(r.Context(), p.OrgID, rows)
	if err != nil {
		slog.Error("ozon error catalog", "err", err)
		writeListing(w, http.StatusServiceUnavailable, "服务暂不可用", "internal")
		return
	}
	writeListingJSON(w, http.StatusOK, struct {
		Data struct {
			Accepted int `json:"accepted"`
		} `json:"data"`
	}{Data: struct {
		Accepted int `json:"accepted"`
	}{Accepted: n}})
}

func (s *Server) getOzonErrors(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, ok := s.orgReader(w, r)
	if !ok {
		return
	}
	if s == nil || s.Ozon == nil {
		writeListing(w, http.StatusServiceUnavailable, "服务暂不可用", "internal")
		return
	}
	body, err := s.Ozon.ListOrg(r.Context(), p.OrgID, r.URL.RawQuery)
	if errors.Is(err, contract.ErrBadQuery) {
		writeListing(w, http.StatusBadRequest, "查询参数无效", "bad_request")
		return
	}
	if err != nil {
		slog.Error("ozon error catalog", "err", err)
		writeListing(w, http.StatusServiceUnavailable, "服务暂不可用", "internal")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (s *Server) orgReader(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return access.Principal{}, false
	}
	if refusal != nil {
		writeListing(w, refusal.Status, refusal.Message, listingCode(refusal))
		return access.Principal{}, false
	}
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeListing(w, http.StatusForbidden, access.MsgNoWorkspace, "forbidden")
		return access.Principal{}, false
	}
	if _, ok := identity.ParseWorkspaceRole(p.WorkspaceRole); !ok {
		writeListing(w, http.StatusForbidden, access.MsgBadWorkspaceRole, "forbidden")
		return access.Principal{}, false
	}
	return p, true
}

func (s *Server) noteRequestError(ctx context.Context, orgID int64, raw []byte, intentID string, status *int) {
	if s == nil || s.Ozon == nil || status == nil {
		return
	}
	req, ok := domain.RequestFromReport(raw, intentID, status)
	if !ok {
		return
	}
	if err := s.Ozon.RecordRequest(ctx, orgID, req); err != nil {
		slog.Error("ozon error catalog", "err", err)
	}
}
