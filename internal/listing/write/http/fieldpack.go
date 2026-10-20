package writehttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// Host serves field packs for the signed-in user. It does not enter a tenant.
type Host struct {
	Pool   *pgxpool.Pool
	Access access.Resolver
	Now    func() time.Time
}

// Mount registers the user-scoped pack routes.
func Mount(r chi.Router, h Host) {
	if h.Now == nil {
		h.Now = time.Now
	}
	r.Get("/api/field-packs", h.list)
	r.Post("/api/field-packs", h.create)
	r.Patch("/api/field-packs/{id}", h.patch)
	r.Delete("/api/field-packs/{id}", h.delete)
	r.Post("/api/field-packs/{id}/share", h.share)
	r.Get("/api/field-library", h.library)
}

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	jsonwire.Write(w, status, apiError{Error: message, Code: code})
}

func (h Host) user(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	if h.Access == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "auth_invalid")
		return access.Principal{}, false
	}
	p, refusal, err := h.Access.Resolve(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return access.Principal{}, false
	}
	if refusal != nil {
		code := "auth_invalid"
		if refusal.Status == http.StatusForbidden {
			code = "forbidden"
		}
		writeErr(w, refusal.Status, refusal.Message, code)
		return access.Principal{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "auth_invalid")
		return access.Principal{}, false
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return access.Principal{}, false
	}
	return *p, true
}

const packColumns = `id::text, name, description_category_id, type_id, language, shared, active, updated_at_ms`

type packView struct {
	ID                    string  `json:"id"`
	Name                  string  `json:"name"`
	DescriptionCategoryID int64   `json:"description_category_id"`
	TypeID                int64   `json:"type_id"`
	Language              string  `json:"language"`
	LibraryID             *string `json:"library_id,omitempty"`
	AuthorIsSelf          bool    `json:"author_is_self"`
	Shared                bool    `json:"shared"`
	Active                bool    `json:"active"`
	Source                string  `json:"source"`
	UpdatedAtMs           int64   `json:"updated_at_ms"`
}

// lockActive takes the field_pack_active advisory key. The key is
// formatted in Go, not in SQL, because pgx treats `$1::text` as a text
// parameter and will not encode a bigint into it. The hashed text is the same.
func lockActive(ctx context.Context, tx pgx.Tx, userID, cat, typ int64, lang string) error {
	key := fmt.Sprintf("field_pack_active:%d:%d:%d:%s", userID, cat, typ, lang)
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key)
	return err
}

func scanPack(row pgx.Row) (packView, error) {
	var view packView
	var shared bool
	if err := row.Scan(&view.ID, &view.Name, &view.DescriptionCategoryID, &view.TypeID, &view.Language, &shared, &view.Active, &view.UpdatedAtMs); err != nil {
		return packView{}, err
	}
	view.Shared = shared
	view.AuthorIsSelf = true
	view.Source = "cloud"
	if shared {
		id := view.ID
		view.LibraryID = &id
	}
	return view, nil
}

func (h Host) list(w http.ResponseWriter, r *http.Request) {
	p, ok := h.user(w, r)
	if !ok {
		return
	}
	cat, typ, lang, ok := coordinate(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	rows, err := h.Pool.Query(r.Context(), `
		SELECT `+packColumns+` FROM public.ozon_field_packs
		WHERE author_user_id = $1 AND description_category_id = $2 AND type_id = $3 AND language = $4
		ORDER BY active DESC, updated_at_ms DESC, id DESC
		LIMIT 100`, p.UserID, cat, typ, lang)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	defer rows.Close()
	packs := []packView{}
	for rows.Next() {
		view, err := scanPack(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
			return
		}
		packs = append(packs, view)
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			Packs []packView `json:"packs"`
		} `json:"data"`
	}{Data: struct {
		Packs []packView `json:"packs"`
	}{Packs: packs}})
}

func coordinate(r *http.Request) (int64, int64, string, bool) {
	q := r.URL.Query()
	cat, err1 := strconv.ParseInt(q.Get("description_category_id"), 10, 64)
	typ, err2 := strconv.ParseInt(q.Get("type_id"), 10, 64)
	lang, ok := LanguageKey(q.Get("language"))
	if err1 != nil || err2 != nil || !ok {
		return 0, 0, "", false
	}
	return cat, typ, lang, true
}

func (h Host) create(w http.ResponseWriter, r *http.Request) {
	p, ok := h.user(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var body struct {
		Name       string `json:"name"`
		Coordinate struct {
			DescriptionCategoryID int64  `json:"description_category_id"`
			TypeID                int64  `json:"type_id"`
			Language              string `json:"language"`
		} `json:"coordinate"`
		Draft json.RawMessage `json:"draft"`
	}
	dec := json.NewDecoder(bytesReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	lang, ok := LanguageKey(body.Coordinate.Language)
	if !ok {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	encoded, err := EncodeBody(body.Draft)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		slog.Error("field pack begin", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := lockActive(r.Context(), tx, p.UserID, body.Coordinate.DescriptionCategoryID, body.Coordinate.TypeID, lang); err != nil {
		slog.Error("field pack lock", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	view, err := scanPack(tx.QueryRow(r.Context(), `
		INSERT INTO public.ozon_field_packs
			(author_user_id, name, description_category_id, type_id, language, defaults_json, shared, active, updated_at_ms, updated_at)
		SELECT $1, $2, $3, $4, $5, $6, false,
		       NOT EXISTS (
		         SELECT 1 FROM public.ozon_field_packs
		          WHERE author_user_id = $1 AND description_category_id = $3 AND type_id = $4 AND language = $5 AND active
		       ),
		       $7, clock_timestamp()
		RETURNING `+packColumns,
		p.UserID, body.Name, body.Coordinate.DescriptionCategoryID, body.Coordinate.TypeID, lang, string(encoded), h.Now().UnixMilli()))
	if err != nil {
		slog.Error("field pack insert", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("field pack commit", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data packView `json:"data"`
	}{Data: view})
}

func (h Host) patch(w http.ResponseWriter, r *http.Request) {
	p, ok := h.user(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	for key := range fields {
		switch key {
		case "name", "active", "draft":
		default:
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
	}
	var name *string
	if rawName, ok := fields["name"]; ok {
		var text string
		if err := json.Unmarshal(rawName, &text); err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
		name = &text
	}
	var active *bool
	if rawActive, ok := fields["active"]; ok {
		var flag bool
		if err := json.Unmarshal(rawActive, &flag); err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
		active = &flag
	}
	var defaults *string
	if rawDraft, ok := fields["draft"]; ok {
		encoded, err := EncodeBody(rawDraft)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
			return
		}
		text := string(encoded)
		defaults = &text
	}
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var cat, typ int64
	var lang string
	err = tx.QueryRow(r.Context(), `
		SELECT description_category_id, type_id, language FROM public.ozon_field_packs
		WHERE id = $1::uuid AND author_user_id = $2`, id, p.UserID).Scan(&cat, &typ, &lang)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "字段包不存在", "not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if err := lockActive(r.Context(), tx, p.UserID, cat, typ, lang); err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if active != nil && *active {
		if _, err := tx.Exec(r.Context(), `
			UPDATE public.ozon_field_packs SET active = false
			WHERE id <> $1::uuid AND author_user_id = $2 AND description_category_id = $3 AND type_id = $4 AND language = $5 AND active`,
			id, p.UserID, cat, typ, lang); err != nil {
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
			return
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE public.ozon_field_packs SET active = true WHERE id = $1::uuid AND author_user_id = $2`, id, p.UserID); err != nil {
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
			return
		}
	}
	view, err := scanPack(tx.QueryRow(r.Context(), `
		UPDATE public.ozon_field_packs
		SET name = COALESCE($3, name),
		    active = COALESCE($4, active),
		    defaults_json = COALESCE($5, defaults_json),
		    updated_at_ms = $6,
		    updated_at = clock_timestamp()
		WHERE id = $1::uuid AND author_user_id = $2
		RETURNING `+packColumns, id, p.UserID, name, active, defaults, h.Now().UnixMilli()))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data packView `json:"data"`
	}{Data: view})
}

func (h Host) share(w http.ResponseWriter, r *http.Request) {
	p, ok := h.user(w, r)
	if !ok {
		return
	}
	var body struct {
		Shared bool `json:"shared"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || json.Unmarshal(raw, &body) != nil {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	view, err := scanPack(h.Pool.QueryRow(r.Context(), `
		UPDATE public.ozon_field_packs
		SET shared = $3, updated_at_ms = $4, updated_at = clock_timestamp()
		WHERE id = $1::uuid AND author_user_id = $2
		RETURNING `+packColumns, chi.URLParam(r, "id"), p.UserID, body.Shared, h.Now().UnixMilli()))
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "字段包不存在", "not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data packView `json:"data"`
	}{Data: view})
}

func (h Host) delete(w http.ResponseWriter, r *http.Request) {
	p, ok := h.user(w, r)
	if !ok {
		return
	}
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM public.ozon_field_packs WHERE id = $1::uuid AND author_user_id = $2`, chi.URLParam(r, "id"), p.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "字段包不存在", "not_found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h Host) library(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.user(w, r); !ok {
		return
	}
	cat, typ, lang, ok := coordinate(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
		return
	}
	rows, err := h.Pool.Query(r.Context(), `
		SELECT p.id::text, p.name, COALESCE(u.name, ''), p.updated_at_ms
		FROM public.ozon_field_packs p
		LEFT JOIN public.account_users u ON u.id = p.author_user_id
		WHERE p.shared AND p.description_category_id = $1 AND p.type_id = $2 AND p.language = $3
		ORDER BY p.updated_at_ms DESC, p.id DESC`, cat, typ, lang)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	defer rows.Close()
	type summary struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		AuthorDisplayName string `json:"author_display_name"`
		UpdatedAtMs       int64  `json:"updated_at_ms"`
	}
	packs := []summary{}
	for rows.Next() {
		var item summary
		if err := rows.Scan(&item.ID, &item.Name, &item.AuthorDisplayName, &item.UpdatedAtMs); err != nil {
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
			return
		}
		packs = append(packs, item)
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			Packs []summary `json:"packs"`
		} `json:"data"`
	}{Data: struct {
		Packs []summary `json:"packs"`
	}{Packs: packs}})
}

func bytesReader(raw []byte) *byteReader { return &byteReader{raw: raw} }

type byteReader struct {
	raw []byte
	at  int
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.at >= len(r.raw) {
		return 0, io.EOF
	}
	n := copy(p, r.raw[r.at:])
	r.at += n
	return n, nil
}
