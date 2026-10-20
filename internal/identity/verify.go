package identity

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func (s *Service) Verify(r *http.Request) Result {
	if s.pool == nil {
		return dbResult(errors.New("no pool"))
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	err := s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
		userID, err := q.ConsumeEmailToken(r.Context(), sqlc.ConsumeEmailTokenParams{TokenHash: hashToken(body.Token), Purpose: "verify"})
		if errors.Is(err, pgx.ErrNoRows) {
			return true, errBadLink
		}
		if err != nil {
			return false, err
		}
		if err := q.MarkEmailVerified(r.Context(), userID); err != nil {
			return false, err
		}
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: 0, UserID: userID, Module: "auth", EntityType: "account",
			EntityID: itoa(userID), ApiMethod: "POST", ApiPath: "/api/auth/verify",
			Action: "email_verified", Message: `{"summary":"验证邮箱"}`,
		})
	})
	if errors.Is(err, errBadLink) {
		return authResult(http.StatusBadRequest, msgBadLink, "VALIDATION")
	}
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}

func (s *Service) VerifyResend(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	verified, err := s.q(r.Context()).EmailVerified(r.Context(), acc.id)
	if err != nil {
		return dbResult(err)
	}
	if !verified {
		if err := s.maybeEmailToken(r.Context(), acc.id, "verify", 24*time.Hour); err != nil {
			return dbResult(err)
		}
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}

func (s *Service) Rename(r *http.Request) Result {
	_, _, acc, res, ok := s.requireAccount(r)
	if !ok {
		return res
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := strictJSON(r, &body); err != nil {
		return authResult(http.StatusBadRequest, msgBadJSON, "VALIDATION")
	}
	name, err := validateName(body.Name)
	if err != nil {
		return authResult(http.StatusBadRequest, err.Error(), "VALIDATION")
	}
	err = s.inTx(r.Context(), func(q *sqlc.Queries) (bool, error) {
		if _, err := q.LockAccount(r.Context(), acc.id); err != nil {
			return false, err
		}
		row, err := q.ProfileName(r.Context(), acc.id)
		if err != nil {
			return false, err
		}
		if row.Name == name {
			return true, nil
		}
		now := time.Now().UTC().UnixMilli()
		if row.NameChangedAtMs.Valid {
			remaining := row.NameChangedAtMs.Int64 + renameCooldownMS - now
			if remaining > 0 {
				return true, fmt.Errorf("%s", cooldownMessage(remaining))
			}
		}
		if err := q.UpdateUserName(r.Context(), sqlc.UpdateUserNameParams{Name: name, ID: acc.id}); err != nil {
			return false, err
		}
		if err := q.StampNameChanged(r.Context(), sqlc.StampNameChangedParams{
			NameChangedAtMs: pgtype.Int8{Int64: now, Valid: true}, UserID: acc.id,
		}); err != nil {
			return false, err
		}
		if err := q.UpdateMemberNames(r.Context(), sqlc.UpdateMemberNamesParams{DisplayName: name, UserID: acc.id}); err != nil {
			return false, err
		}
		message, _ := json.Marshal(struct {
			Summary string `json:"summary"`
			From    string `json:"from"`
			To      string `json:"to"`
		}{Summary: fmt.Sprintf("将名字从 %s 修改为 %s", row.Name, name), From: row.Name, To: name})
		return true, q.InsertAudit(r.Context(), sqlc.InsertAuditParams{
			OrgID: 0, UserID: acc.id, Module: "auth", EntityType: "account",
			EntityID: acc.publicID, ApiMethod: "PUT", ApiPath: "/api/auth/name",
			Action: "account_name_changed", Message: string(message),
		})
	})
	if err != nil {
		if strings.Contains(err.Error(), "名字") {
			return authResult(http.StatusBadRequest, err.Error(), "VALIDATION")
		}
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true}}`)}
}
