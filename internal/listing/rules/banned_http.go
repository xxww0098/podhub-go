package rules

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/internal/listing/rules/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// BannedHost is the super-admin write API. Reads stay on the generated routes.
type BannedHost struct {
	Pool   *pgxpool.Pool
	Engine listing.Engine
	Access access.Resolver
}

// MountBannedWrites registers POST, PUT and DELETE. GET is already generated.
func MountBannedWrites(r chi.Router, h BannedHost) {
	r.Post("/api/admin/banned-tags", h.create)
	r.Put("/api/admin/banned-tags/{id}", h.update)
	r.Delete("/api/admin/banned-tags/{id}", h.remove)
}

type adminError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeAdmin(w http.ResponseWriter, status int, message, code string) {
	jsonwire.Write(w, status, adminError{Error: message, Code: code})
}

func (h BannedHost) super(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	if h.Access == nil {
		writeAdmin(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_INVALID")
		return access.Principal{}, false
	}
	p, refusal, err := h.Access.Resolve(r)
	if err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return access.Principal{}, false
	}
	if refusal != nil {
		code := "AUTH_INVALID"
		if refusal.Status == http.StatusForbidden {
			code = "FORBIDDEN"
		}
		writeAdmin(w, refusal.Status, refusal.Message, code)
		return access.Principal{}, false
	}
	if p == nil {
		writeAdmin(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_INVALID")
		return access.Principal{}, false
	}
	if status, message, ok := access.SuperAdmin(*p); !ok {
		writeAdmin(w, status, message, "FORBIDDEN")
		return access.Principal{}, false
	}
	if h.Pool == nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return access.Principal{}, false
	}
	return *p, true
}

type tagWire struct {
	ID        int64  `json:"id"`
	Term      string `json:"term"`
	MatchMode string `json:"matchMode"`
	Note      string `json:"note"`
	CreatedBy string `json:"createdBy"`
	CreatedAt string `json:"createdAt"`
	Enabled   bool   `json:"enabled"`
}

func (h BannedHost) list(r *http.Request) ([]tagWire, error) {
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, term, match_mode, note, created_by, created_at::text, enabled
		FROM public.banned_tags ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []tagWire{}
	for rows.Next() {
		var item tagWire
		if err := rows.Scan(&item.ID, &item.Term, &item.MatchMode, &item.Note, &item.CreatedBy, &item.CreatedAt, &item.Enabled); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (h BannedHost) writeList(w http.ResponseWriter, r *http.Request) {
	tags, err := h.list(r)
	if err != nil {
		slog.Error("banned tags list", "err", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			Tags []tagWire `json:"tags"`
		} `json:"data"`
	}{Data: struct {
		Tags []tagWire `json:"tags"`
	}{Tags: tags}})
}

func (h BannedHost) create(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.super(w, r)
	if !ok {
		return
	}
	fields, ok := h.body(w, r)
	if !ok {
		return
	}
	term, mode, note, enabled, ok := h.fields(w, r, fields, true)
	if !ok {
		return
	}
	publicID, err := h.publicID(r, actor.UserID)
	if err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	var id int64
	err = h.Pool.QueryRow(r.Context(), `
		INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`, term, mode, note, publicID, enabled).Scan(&id)
	if err != nil {
		if duplicate(err) {
			writeAdmin(w, http.StatusConflict, "这个受限词已经存在", "CONFLICT")
			return
		}
		slog.Error("banned tag insert", "err", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	InvalidateBannedTags()
	h.audit(r, actor, "POST", "/api/admin/banned-tags", "banned_tag_created", id, map[string]any{
		"term": term, "matchMode": mode, "enabled": enabled,
	})
	h.writeList(w, r)
}

func (h BannedHost) update(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.super(w, r)
	if !ok {
		return
	}
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return
	}
	fields, ok := h.body(w, r)
	if !ok {
		return
	}
	term, mode, note, enabled, ok := h.fields(w, r, fields, false)
	if !ok {
		return
	}
	tag, err := h.Pool.Exec(r.Context(), `
		UPDATE public.banned_tags SET term = $2, match_mode = $3, note = $4, enabled = $5 WHERE id = $1`,
		id, term, mode, note, enabled)
	if err != nil {
		if duplicate(err) {
			writeAdmin(w, http.StatusConflict, "这个受限词已经存在", "CONFLICT")
			return
		}
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdmin(w, http.StatusNotFound, "受限词不存在", "NOT_FOUND")
		return
	}
	InvalidateBannedTags()
	h.audit(r, actor, "PUT", "/api/admin/banned-tags/{id}", "banned_tag_updated", id, map[string]any{
		"term": term, "matchMode": mode, "enabled": enabled,
	})
	h.writeList(w, r)
}

func (h BannedHost) remove(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.super(w, r)
	if !ok {
		return
	}
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return
	}
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM public.banned_tags WHERE id = $1`, id)
	if err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdmin(w, http.StatusNotFound, "受限词不存在", "NOT_FOUND")
		return
	}
	InvalidateBannedTags()
	h.audit(r, actor, "DELETE", "/api/admin/banned-tags/{id}", "banned_tag_deleted", id, map[string]any{"id": id})
	h.writeList(w, r)
}

func (h BannedHost) body(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return nil, false
	}
	dec := json.NewDecoder(bytesReader(raw))
	dec.DisallowUnknownFields()
	var fields map[string]json.RawMessage
	if err := dec.Decode(&fields); err != nil {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return nil, false
	}
	for key := range fields {
		switch key {
		case "term", "matchMode", "note", "enabled":
		default:
			writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
			return nil, false
		}
	}
	return fields, true
}

func (h BannedHost) fields(w http.ResponseWriter, r *http.Request, fields map[string]json.RawMessage, create bool) (string, string, string, bool, bool) {
	rawTerm, ok := fields["term"]
	rawMode, okMode := fields["matchMode"]
	if !ok || !okMode {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return "", "", "", false, false
	}
	var term, mode string
	if json.Unmarshal(rawTerm, &term) != nil || json.Unmarshal(rawMode, &mode) != nil {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return "", "", "", false, false
	}
	if h.Engine == nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return "", "", "", false, false
	}
	canonical, err := listing.CanonicalTerm(r.Context(), h.Engine, term)
	if err != nil {
		if errors.Is(err, listing.ErrTermLength) {
			writeAdmin(w, http.StatusBadRequest, err.Error(), "VALIDATION")
			return "", "", "", false, false
		}
		slog.Error("banned term", "err", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return "", "", "", false, false
	}
	if mode != "exact" && mode != "stem" {
		writeAdmin(w, http.StatusBadRequest, "匹配方式只能是 exact 或 stem", "VALIDATION")
		return "", "", "", false, false
	}
	note := ""
	if rawNote, ok := fields["note"]; ok {
		if json.Unmarshal(rawNote, &note) != nil {
			writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
			return "", "", "", false, false
		}
	}
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > 200 {
		writeAdmin(w, http.StatusBadRequest, "备注不能超过 200 个字符", "VALIDATION")
		return "", "", "", false, false
	}
	enabled := true
	if rawEnabled, ok := fields["enabled"]; ok {
		if json.Unmarshal(rawEnabled, &enabled) != nil {
			writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
			return "", "", "", false, false
		}
	} else if !create {
		writeAdmin(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
		return "", "", "", false, false
	}
	return canonical, mode, note, enabled, true
}

func (h BannedHost) publicID(r *http.Request, userID int64) (string, error) {
	var id string
	err := h.Pool.QueryRow(r.Context(), `SELECT public_id FROM public.account_users WHERE id = $1`, userID).Scan(&id)
	return id, err
}

func (h BannedHost) audit(r *http.Request, actor access.Principal, method, path, action string, id int64, message map[string]any) {
	raw, err := jsonwire.Marshal(message)
	if err != nil {
		slog.Warn("banned tag audit", "err", err)
		return
	}
	org := actor.OrgID
	if org < 0 {
		org = 0
	}
	err = contract.InsertAuditFn(r.Context(), h.Pool, org, actor.UserID, itoa(id), method, path, action, string(raw))
	if err != nil {
		slog.Warn("banned tag audit", "action", action, "err", err)
	}
}

func duplicate(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func parseID(raw string) (int64, error) {
	var n int64
	if raw == "" {
		return 0, errors.New("id")
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, errors.New("id")
		}
		n = n*10 + int64(r-'0')
	}
	return n, nil
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func bytesReader(raw []byte) *byteReader { return &byteReader{raw: raw} }

type byteReader struct {
	raw []byte
	at  int
}

func (b *byteReader) Read(p []byte) (int, error) {
	if b.at >= len(b.raw) {
		return 0, io.EOF
	}
	n := copy(p, b.raw[b.at:])
	b.at += n
	return n, nil
}
