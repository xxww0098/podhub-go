package identity

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

// Logout ends the one session this browser holds.
func (s *Service) Logout(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	token := SessionCredentials(r.Header).Presented()
	if token != "" {
		err := s.inTx(r.Context(), func(_ pgx.Tx, q *sqlc.Queries) (bool, error) {
			if _, err := q.DeleteSessionByHash(r.Context(), hashToken(token)); err != nil {
				return false, err
			}
			return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
				OrgID: 0, UserID: 0, Module: "auth", EntityType: "session", EntityID: "*",
				ApiMethod: "POST", ApiPath: "/api/auth/logout", Action: "session_revoked",
				Message: `{"summary":"注销会话"}`,
			})
		})
		if err != nil {
			return dbResult(err)
		}
	}
	return Result{Status: http.StatusNoContent, Cookies: SessionCookies("")}
}
