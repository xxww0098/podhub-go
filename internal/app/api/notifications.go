package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/xxww0098/podhub-go/internal/identity"
)

func (s *Server) NotificationList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	identity.WriteResult(w, s.identity().Notifications(r))
}

func (s *Server) NotificationRead(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().MarkNotificationsRead(r, chi.URLParam(r, "uuid")))
}

func (s *Server) NotificationReadAll(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().MarkNotificationsRead(r, ""))
}
