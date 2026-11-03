package api

import (
	"net/http"

	"github.com/xxww0098/podhub-go/internal/identity"
)

// Workspace lifecycle and membership. The identity service owns the
// transaction, permission checks and audit rows; these handlers only adapt
// the generated route arguments.

func (s *Server) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().ListWorkspaces(r))
}

func (s *Server) RenameWorkspace(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().RenameWorkspace(r))
}

func (s *Server) DissolveWorkspace(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().DissolveWorkspace(r))
}

func (s *Server) LeaveWorkspace(w http.ResponseWriter, r *http.Request) {
	identity.WriteResult(w, s.identity().LeaveWorkspace(r))
}

func (s *Server) RemoveWorkspaceMember(w http.ResponseWriter, r *http.Request, id int64) {
	identity.WriteResult(w, s.identity().RemoveWorkspaceMember(r, id))
}

func (s *Server) ChangeWorkspaceMemberRole(w http.ResponseWriter, r *http.Request, id int64) {
	identity.WriteResult(w, s.identity().ChangeWorkspaceMemberRole(r, id))
}
