package ratingshttp

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/ratings/contract"
	"github.com/xxww0098/podhub-go/internal/ratings/domain"
	"github.com/xxww0098/podhub-go/internal/ratings/service"
)

// Deps serves the rating reads. Svc nil answers 503 after the session check.
type Deps struct {
	Access access.Resolver
	Svc    *service.Service
}

// Mount registers the store rating reads.
func Mount(r chi.Router, d Deps) {
	h := handler{deps: d}
	r.Get("/api/workspaces/stores/{uuid}/ratings", h.list)
	r.Get("/api/workspaces/stores/{uuid}/ratings/history", h.history)
}

type handler struct{ deps Deps }

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, status, apiError{Error: message, Code: code})
}

func writeOK(w http.ResponseWriter, body any) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	jsonwire.Write(w, http.StatusOK, body)
}

func (h handler) account(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	if h.deps.Access == nil {
		writeErr(w, http.StatusUnauthorized, access.MsgUnauthenticated, "auth_invalid")
		return access.Principal{}, false
	}
	p, refusal, err := h.deps.Access.Resolve(r)
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
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeErr(w, http.StatusForbidden, access.MsgNoWorkspace, "forbidden")
		return access.Principal{}, false
	}
	return *p, true
}

func (h handler) list(w http.ResponseWriter, r *http.Request) {
	p, ok := h.account(w, r)
	if !ok {
		return
	}
	storeID, ok := storeUUID(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return
	}
	if h.deps.Svc == nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "internal")
		return
	}
	rows, err := h.deps.Svc.List(r.Context(), p.OrgID, p.UserID, storeID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	items := make([]listItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, toList(row))
	}
	writeOK(w, struct {
		StoreID string     `json:"store_id"`
		Items   []listItem `json:"items"`
	}{StoreID: storeID, Items: items})
}

func (h handler) history(w http.ResponseWriter, r *http.Request) {
	p, ok := h.account(w, r)
	if !ok {
		return
	}
	storeID, ok := storeUUID(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return
	}
	q := r.URL.Query()
	limit := 50
	if q.Has("limit") {
		n, err := strconv.Atoi(q.Get("limit"))
		if err != nil || n < 1 || n > 100 {
			writeErr(w, http.StatusBadRequest, "查询参数无效", "validation")
			return
		}
		limit = n
	}
	var cursor int64
	if q.Get("cursor") != "" {
		n, err := strconv.ParseInt(q.Get("cursor"), 10, 64)
		if err != nil || n < 1 {
			writeErr(w, http.StatusBadRequest, "查询参数无效", "validation")
			return
		}
		cursor = n
	}
	if h.deps.Svc == nil {
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "internal")
		return
	}
	rows, err := h.deps.Svc.History(r.Context(), p.OrgID, p.UserID, storeID, strings.TrimSpace(q.Get("rating_key")), cursor, limit+1)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	var next *int64
	if len(rows) > limit {
		rows = rows[:limit]
		id := rows[len(rows)-1].ID
		next = &id
	}
	items := make([]histItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, toHist(row))
	}
	writeOK(w, struct {
		StoreID    string     `json:"store_id"`
		Items      []histItem `json:"items"`
		NextCursor *int64     `json:"next_cursor"`
	}{StoreID: storeID, Items: items, NextCursor: next})
}

func writeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, contract.ErrNotFound):
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
	case errors.Is(err, contract.ErrForbidden):
		writeErr(w, http.StatusForbidden, "工作空间成员当前不可用", "forbidden")
	case errors.Is(err, contract.ErrBadQuery):
		writeErr(w, http.StatusBadRequest, "查询参数无效", "validation")
	default:
		msg := err.Error()
		if domain.SecretLike(msg) {
			msg = "store ratings failed"
		}
		slog.Error("store ratings", "err", msg)
		writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "internal")
	}
}

func storeUUID(r *http.Request) (string, bool) {
	return domainUUID(chi.URLParam(r, "uuid"))
}

func domainUUID(raw string) (string, bool) {
	s := strings.TrimSpace(strings.ToLower(raw))
	hex := strings.ReplaceAll(s, "-", "")
	if len(hex) != 32 {
		return "", false
	}
	for _, c := range hex {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	if strings.Contains(s, "-") && (len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-') {
		return "", false
	}
	return hex[0:8] + "-" + hex[8:12] + "-" + hex[12:16] + "-" + hex[16:20] + "-" + hex[20:], true
}

type listItem struct {
	RatingKey    string          `json:"rating_key"`
	Name         string          `json:"name"`
	ValueType    string          `json:"value_type"`
	Status       string          `json:"status"`
	CurrentValue json.RawMessage `json:"current_value"`
	PastValue    json.RawMessage `json:"past_value"`
	NoData       bool            `json:"no_data"`
	Direction    string          `json:"direction"`
	SyncedAt     string          `json:"synced_at"`
}

type histItem struct {
	ID           int64           `json:"id"`
	RatingKey    string          `json:"rating_key"`
	Name         string          `json:"name"`
	ValueType    string          `json:"value_type"`
	Status       string          `json:"status"`
	CurrentValue json.RawMessage `json:"current_value"`
	PastValue    json.RawMessage `json:"past_value"`
	NoData       bool            `json:"no_data"`
	RecordedAt   string          `json:"recorded_at"`
}

func toList(row domain.Snapshot) listItem {
	noData, cur, past, dir := domain.Present(row.Status, row.Current, row.Past, row.Previous)
	return listItem{
		RatingKey: row.Key, Name: row.Name, ValueType: row.ValueType, Status: row.Status,
		CurrentValue: rawNum(noData, cur), PastValue: rawNum(noData, past),
		NoData: noData, Direction: dir, SyncedAt: row.SyncedAt.UTC().Format(time.RFC3339),
	}
}

func toHist(row domain.HistoryRow) histItem {
	noData, cur, past, _ := domain.Present(row.Status, row.Current, row.Past, nil)
	return histItem{
		ID: row.ID, RatingKey: row.Key, Name: row.Name, ValueType: row.ValueType, Status: row.Status,
		CurrentValue: rawNum(noData, cur), PastValue: rawNum(noData, past),
		NoData: noData, RecordedAt: row.At.UTC().Format(time.RFC3339),
	}
}

func rawNum(noData bool, text string) json.RawMessage {
	if noData || text == "" {
		return json.RawMessage("null")
	}
	return json.RawMessage(text)
}
