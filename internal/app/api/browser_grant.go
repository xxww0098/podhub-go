package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/repo"
)

// RegisterBrowserDirect mounts the browser key grant and the import report.
// Neither route enqueues listing.submit. The grant reads the kill switch
// bool already stored on the server.
func RegisterBrowserDirect(r chi.Router, s *Server) {
	if r == nil || s == nil {
		return
	}
	r.Post("/api/listing/browser/grant", s.postBrowserGrant)
	r.Post("/api/listing/browser/import-info", s.postBrowserImportInfo)
	r.Post("/api/listing/browser/report", s.postBrowserReport)
	r.Get("/api/listing/ozon-errors", s.getOzonErrors)
}

func (s *Server) postBrowserGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, ok := s.submitActor(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeListing(w, http.StatusBadRequest, submit.ErrBadRequest.Error(), "bad_request")
		return
	}
	in, err := submit.ParseGrantBody(body)
	if err != nil {
		_ = writeSubmit(w, err)
		return
	}
	in.OrgID = p.OrgID
	in.WritesDisabled = s.WritesDisabled
	in.Now = s.now()
	open := s.OpenGrant
	if open == nil {
		open = s.Seals.OpenStore
	}
	result, err := submit.Grant(r.Context(), s.Pool, in, func(ctx context.Context) error {
		return s.reserveGrant(ctx, in.StoreID)
	}, open)
	if writeSubmit(w, err) {
		return
	}
	writeListingJSON(w, http.StatusOK, struct {
		Data submit.GrantResult `json:"data"`
	}{Data: result})
}

func (s *Server) postBrowserReport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, ok := s.submitActor(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeListing(w, http.StatusBadRequest, submit.ErrBadRequest.Error(), "bad_request")
		return
	}
	in, err := submit.ParseReportBody(body)
	if err != nil {
		_ = writeSubmit(w, err)
		return
	}
	in.OrgID = p.OrgID
	result, err := submit.Report(r.Context(), s.Pool, in)
	if writeSubmit(w, err) {
		return
	}
	s.noteRequestError(r.Context(), p.OrgID, body, in.IntentID, in.HTTPStatus)
	writeListingJSON(w, http.StatusOK, struct {
		Data submit.ReportResult `json:"data"`
	}{Data: result})
}

func (s *Server) reserveGrant(ctx context.Context, storeID string) error {
	if s.Pool == nil {
		return errors.New("grant pool is nil")
	}
	interval := time.Second / time.Duration(sellerdomain.DefaultRatePerSecond)
	burst := interval * time.Duration(sellerdomain.DefaultBurst-1)
	wait, err := sellerrepo.Reserve(ctx, s.Pool, sellerdomain.Namespace(), "browser-grant:"+storeID, interval, burst, sellerdomain.MaxRateLimitWait)
	if errors.Is(err, sellerrepo.ErrRateLimited) {
		return submit.ErrGrantLimited
	}
	if err != nil {
		return err
	}
	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
