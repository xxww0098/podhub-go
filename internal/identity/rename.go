package identity

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

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
	err = s.inTx(r.Context(), func(_ pgx.Tx, q *sqlc.Queries) (bool, error) {
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
