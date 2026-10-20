package identity

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) Logout(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	cred := SessionCredentials(r.Header)
	token := cred.Presented()
	if token != "" {
		err := s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
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
	sid, stack := AfterRevoke(cred, []string{token})
	return Result{Status: http.StatusNoContent, Cookies: SessionCookies(sid, stack)}
}

func (s *Service) SwitchAccount(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	var body struct {
		UUID string `json:"uuid"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	if !uuidShaped(strings.TrimSpace(body.UUID)) {
		return authResult(http.StatusBadRequest, msgBadAccount, "VALIDATION")
	}
	cred := SessionCredentials(r.Header)
	candidates := cred.StackCandidates()
	if len(candidates) == 0 {
		return authResult(http.StatusUnauthorized, msgLoggedOut, "AUTH_INVALID")
	}
	var chosen string
	for _, token := range candidates {
		acc, ok, err := s.resolveToken(r.Context(), token)
		if err != nil {
			return dbResult(err)
		}
		if ok && acc.publicID == strings.TrimSpace(body.UUID) {
			chosen = token
			break
		}
	}
	if chosen == "" {
		return authResult(http.StatusBadRequest, msgNotInStack, "VALIDATION")
	}
	acc, _, err := s.resolveToken(r.Context(), chosen)
	if err != nil {
		return dbResult(err)
	}
	stack := cred.Stack
	if !containsToken(stack, chosen) {
		stack = append(append([]string{}, stack...), chosen)
	}
	cred.SID = chosen
	bodyBytes, err := s.sessionBody(r.Context(), cred, chosen, acc)
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: bodyBytes, Cookies: SessionCookies(chosen, stack)}
}

func uuidShaped(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, r := range value {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
				return false
			}
		}
	}
	return true
}

func (s *Service) DeleteAccount(r *http.Request, publicID string) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	if !uuidShaped(publicID) {
		return authResult(http.StatusBadRequest, msgBadAccount, "VALIDATION")
	}
	cred := SessionCredentials(r.Header)
	var removed []string
	for _, token := range cred.StackCandidates() {
		acc, ok, err := s.resolveToken(r.Context(), token)
		if err != nil {
			return dbResult(err)
		}
		if ok && acc.publicID == publicID {
			removed = append(removed, token)
		}
	}
	if len(removed) > 0 {
		hashes := make([]string, len(removed))
		userID := int64(0)
		for i, token := range removed {
			hashes[i] = hashToken(token)
			if acc, ok, err := s.resolveToken(r.Context(), token); err != nil {
				return dbResult(err)
			} else if ok {
				userID = acc.id
			}
		}
		err := s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
			if _, err := q.DeleteSessionsByHashes(r.Context(), hashes); err != nil {
				return false, err
			}
			message, _ := json.Marshal(struct {
				Summary  string `json:"summary"`
				Sessions int    `json:"sessions"`
			}{Summary: "注销账号在本设备的会话", Sessions: len(removed)})
			return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
				OrgID: 0, UserID: userID, Module: "auth", EntityType: "session",
				EntityID: itoa(userID), ApiMethod: "DELETE", ApiPath: "/api/auth/accounts/{uuid}",
				Action: "session_revoked", Message: string(message),
			})
		})
		if err != nil {
			return dbResult(err)
		}
	}
	sid, stack := AfterRevoke(cred, removed)
	return Result{Status: http.StatusNoContent, Cookies: SessionCookies(sid, stack)}
}
