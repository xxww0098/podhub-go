package adminhttp

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func familyOf(path string) string {
	switch {
	case strings.HasPrefix(path, "/api/admin/supplier-accounts"), strings.HasPrefix(path, "/api/admin/supplier-withdrawals"):
		return "portal"
	case strings.HasPrefix(path, "/api/admin/supplier-automation"):
		return "auto"
	case strings.HasPrefix(path, "/api/admin/supplier-"):
		return "dbs"
	default:
		return "legacy"
	}
}

func privateCatalog(path string) bool {
	return strings.HasPrefix(path, "/api/admin/supplier-dbs") ||
		strings.HasPrefix(path, "/api/admin/supplier-db-storage") ||
		strings.HasPrefix(path, "/api/admin/supplier-prompts")
}

func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}

type privateWriter struct {
	http.ResponseWriter
	wrote bool
}

func (p *privateWriter) WriteHeader(code int) {
	if !p.wrote {
		p.Header().Set("Cache-Control", "private, no-store")
		p.Header().Add("Vary", "Cookie, Authorization")
		p.wrote = true
	}
	p.ResponseWriter.WriteHeader(code)
}

func (p *privateWriter) Write(b []byte) (int, error) {
	if !p.wrote {
		p.WriteHeader(http.StatusOK)
	}
	return p.ResponseWriter.Write(b)
}

func writeFamily(w http.ResponseWriter, fam string, status int, message, kind string) {
	code := spell(fam, kind, status)
	if status >= 400 {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	writeErr(w, status, message, code)
}

func writeAuth(w http.ResponseWriter, fam string, status int, message string) {
	kind := contract.KindInternal
	if status == http.StatusUnauthorized {
		kind = "auth"
	}
	if status == http.StatusForbidden {
		kind = contract.KindForbidden
	}
	writeFamily(w, fam, status, message, kind)
}

func spell(fam, kind string, status int) string {
	scream := fam != "portal"
	switch {
	case fam == "legacy":
		if status == http.StatusUnauthorized {
			return "AUTH_INVALID"
		}
		if status == http.StatusForbidden {
			return "FORBIDDEN"
		}
		return "INTERNAL"
	case kind == "auth" || status == http.StatusUnauthorized:
		if scream {
			return "AUTH_INVALID"
		}
		return "auth_invalid"
	case kind == contract.KindForbidden || status == http.StatusForbidden:
		if scream {
			return "FORBIDDEN"
		}
		return "forbidden"
	case kind == contract.KindValidation:
		if scream {
			return "VALIDATION"
		}
		return "validation"
	case kind == contract.KindNotFound:
		if scream {
			return "NOT_FOUND"
		}
		return "not_found"
	case kind == contract.KindConflict:
		if scream {
			return "CONFLICT"
		}
		return "conflict"
	case kind == contract.KindWritesDisabled:
		if scream {
			return "WRITES_DISABLED"
		}
		return "writes_disabled"
	default:
		if scream {
			return "INTERNAL"
		}
		return "internal"
	}
}

func writeFail(w http.ResponseWriter, fam string, err error) {
	f, ok := contract.AsFail(err)
	if !ok {
		writeFamily(w, fam, http.StatusInternalServerError, msgUnavailable, contract.KindInternal)
		return
	}
	status := f.Status
	if status == 0 {
		switch f.Kind {
		case contract.KindValidation:
			status = http.StatusBadRequest
		case contract.KindNotFound:
			status = http.StatusNotFound
		case contract.KindConflict:
			status = http.StatusConflict
		case contract.KindForbidden:
			status = http.StatusForbidden
		case contract.KindWritesDisabled:
			status = http.StatusServiceUnavailable
		case contract.KindUnavailable:
			status = http.StatusServiceUnavailable
		default:
			status = http.StatusInternalServerError
		}
	}
	if f.RetryAfter > 0 {
		w.Header().Set("Retry-After", "1")
	}
	code := f.Code
	if code == "" {
		code = spell(fam, f.Kind, status)
	}
	if len(f.Missing) == 0 {
		writeErr(w, status, f.Message, code)
		return
	}
	if status >= 400 {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	writeJSON(w, status, struct {
		Error   string   `json:"error"`
		Code    string   `json:"code"`
		Missing []string `json:"missing"`
	}{f.Message, code, f.Missing})
}

func writeData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, struct {
		Data any `json:"data"`
	}{Data: data})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, msgUnavailable, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(bytes.TrimRight(buf.Bytes(), "\n")); err != nil {
		slog.Error("json write", "err", err)
	}
}

func actorOf(p Session) contract.Actor {
	role := strings.ToLower(strings.TrimSpace(p.PlatformRole))
	return contract.Actor{UserID: p.UserID, OrgID: p.OrgID, Role: role}
}

func (h handler) svc() service.Service {
	if h.Supplier == nil {
		return service.Service{}
	}
	return *h.Supplier
}

func (h handler) dispatch(w http.ResponseWriter, r *http.Request, rt Route, p Session, early []byte) bool {
	fam := familyOf(rt.Path)
	actor := actorOf(p)
	svc := h.svc()
	switch rt.Method + " " + rt.Path {
	case "GET /api/admin/supplier-dbs":
		rows, err := svc.ListDbs(r.Context(), actor)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Dbs []domain.SupplierDb `json:"dbs"`
		}{rows})
		return true
	case "POST /api/admin/supplier-dbs":
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return true
		}
		db, initial, err := svc.CreateDb(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusCreated, mutation(db, initial))
		return true
	case "PUT /api/admin/supplier-dbs/{source_id}":
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return true
		}
		db, initial, err := svc.UpdateDb(r.Context(), actor, chi.URLParam(r, "source_id"), body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, mutation(db, initial))
		return true
	case "DELETE /api/admin/supplier-dbs/{source_id}":
		id := chi.URLParam(r, "source_id")
		if err := svc.DeleteDb(r.Context(), actor, id); err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			SourceID string `json:"sourceId"`
		}{id})
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/props":
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return true
		}
		prop, err := svc.CreateProp(r.Context(), actor, chi.URLParam(r, "source_id"), body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusCreated, struct {
			Prop domain.Prop `json:"prop"`
		}{prop})
		return true
	case "PUT /api/admin/supplier-dbs/{source_id}/props/{prop_id}":
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return true
		}
		prop, err := svc.UpdateProp(r.Context(), actor, chi.URLParam(r, "source_id"), chi.URLParam(r, "prop_id"), body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Prop domain.Prop `json:"prop"`
		}{prop})
		return true
	case "DELETE /api/admin/supplier-dbs/{source_id}/props/{prop_id}":
		id := chi.URLParam(r, "prop_id")
		n, err := svc.DeleteProp(r.Context(), actor, chi.URLParam(r, "source_id"), id)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			PropID         string `json:"propId"`
			RowsWithValues int64  `json:"rowsWithValues"`
		}{id, n})
		return true
	case "DELETE /api/admin/supplier-dbs/{source_id}/rows/{product_id}":
		id := chi.URLParam(r, "product_id")
		if err := svc.DeleteRow(r.Context(), actor, chi.URLParam(r, "source_id"), id); err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			ProductID string `json:"productId"`
		}{id})
		return true
	case "GET /api/admin/supplier-accounts":
		groups, err := svc.ListAccounts(r.Context(), actor)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Groups []domain.AccountGroup `json:"groups"`
		}{groups})
		return true
	case "POST /api/admin/supplier-accounts":
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return true
		}
		member, initial, err := svc.CreateAccount(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, accountMutation(member, initial))
		return true
	case "PATCH /api/admin/supplier-accounts/{member_id}":
		member, initial, err := svc.PatchAccount(r.Context(), actor, chi.URLParam(r, "member_id"), early)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, accountMutation(member, initial))
		return true
	case "DELETE /api/admin/supplier-accounts/{member_id}":
		id := chi.URLParam(r, "member_id")
		if err := svc.DeleteAccount(r.Context(), actor, id); err != nil {
			writeFail(w, fam, err)
			return true
		}
		canon, _ := domain.CanonicalUUID(id)
		writeData(w, http.StatusOK, struct {
			MemberID string `json:"memberId"`
			Unbound  bool   `json:"unbound"`
		}{canon, true})
		return true
	case "GET /api/admin/supplier-prompts":
		rows, err := svc.ListPrompts(r.Context(), actor)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Prompts []domain.Prompt `json:"prompts"`
		}{rows})
		return true
	case "GET /api/admin/supplier-withdrawals":
		rows, err := svc.ListWithdrawals(r.Context(), actor, r.URL.Query().Get("status"))
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Withdrawals []domain.Withdrawal `json:"withdrawals"`
		}{rows})
		return true
	case "POST /api/admin/supplier-withdrawals/{withdrawal_id}/pay":
		reference, err := domain.DecodePay(early)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		row, err := svc.PayWithdrawal(r.Context(), actor, chi.URLParam(r, "withdrawal_id"), reference, svc.NowMillis())
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Withdrawals []domain.Withdrawal `json:"withdrawals"`
		}{[]domain.Withdrawal{row}})
		return true
	case "POST /api/admin/supplier-withdrawals/{withdrawal_id}/reject":
		reason, err := domain.DecodeReject(early)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		row, err := svc.RejectWithdrawal(r.Context(), actor, chi.URLParam(r, "withdrawal_id"), reason, svc.NowMillis())
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Withdrawals []domain.Withdrawal `json:"withdrawals"`
		}{[]domain.Withdrawal{row}})
		return true
	case "GET /api/admin/supplier-automation/grants":
		if !h.liveStaff(w, r, fam, actor) {
			return true
		}
		rows, err := svc.ListGrants(r.Context(), actor)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Grants []domain.GrantView `json:"grants"`
		}{rows})
		return true
	case "POST /api/admin/supplier-automation/grants":
		if !h.liveStaff(w, r, fam, actor) {
			return true
		}
		body, err := readBody(r)
		if err != nil {
			writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
			return true
		}
		grant, token, err := svc.CreateGrant(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Grant domain.GrantView `json:"grant"`
			Token string           `json:"token"`
		}{grant, token})
		return true
	case "POST /api/admin/supplier-automation/grants/{id}/revoke":
		if !h.liveStaff(w, r, fam, actor) {
			return true
		}
		id, err := svc.RevokeGrant(r.Context(), actor, chi.URLParam(r, "id"))
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			ID      string `json:"id"`
			Revoked bool   `json:"revoked"`
		}{id, true})
		return true
	default:
		return h.dispatchX1(w, r, rt, actor)
	}
}

func (h handler) liveStaff(w http.ResponseWriter, r *http.Request, fam string, actor contract.Actor) bool {
	found, staff, err := h.svc().AccountStaff(r.Context(), actor.UserID)
	if err != nil {
		writeFail(w, fam, err)
		return false
	}
	if !found {
		writeFamily(w, fam, http.StatusUnauthorized, "登录已失效", "auth")
		return false
	}
	if !staff {
		writeFamily(w, fam, http.StatusForbidden, "需要平台管理员权限", contract.KindForbidden)
		return false
	}
	return true
}

type dbMutation struct {
	Db              domain.SupplierDb `json:"db"`
	InitialPassword *string           `json:"initialPassword,omitempty"`
}

func mutation(db domain.SupplierDb, initial *string) dbMutation {
	return dbMutation{Db: db, InitialPassword: initial}
}

type accountMutationBody struct {
	Member          domain.Member `json:"member"`
	InitialPassword *string       `json:"initialPassword,omitempty"`
}

func accountMutation(member domain.Member, initial *string) accountMutationBody {
	return accountMutationBody{Member: member, InitialPassword: initial}
}
