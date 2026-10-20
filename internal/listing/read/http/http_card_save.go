package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) finishCreate(w http.ResponseWriter, r *http.Request, pUser, org int64, mode, title string, store *string, payload json.RawMessage, source *string, product *string) {
	switch mode {
	case "blank":
		h.insertBlank(w, r, pUser, org, title, store, payload)
	case "copyCard":
		h.insertCopy(w, r, pUser, org, title, source)
	case "fromSupplier":
		if product == nil || strings.TrimSpace(*product) == "" {
			writeErr(w, http.StatusBadRequest, "fromSupplier 需要 supplierProductId", "validation")
			return
		}
		h.insertSupplier(w, r, pUser, org, title, store, strings.TrimSpace(*product))
	default:
		notWritten(w)
	}
}

func (h Host) insertBlank(w http.ResponseWriter, r *http.Request, user, org int64, title string, store *string, payload json.RawMessage) {
	storeID, ok := h.visibleStore(w, r, org, user, store)
	if !ok {
		return
	}
	body, err := PrepareCard(payload, nil)
	if err != nil {
		writeDoc(w, err)
		return
	}
	item, err := h.insertCard(r, org, user, title, storeID, body, false)
	if err != nil {
		writeDB(w, err)
		return
	}
	writeCard(w, item)
}

func (h Host) insertCopy(w http.ResponseWriter, r *http.Request, user, org int64, title string, source *string) {
	if source == nil {
		writeErr(w, http.StatusBadRequest, "copyCard 需要 sourceCardId", "validation")
		return
	}
	id, ok := CanonicalUUID(*source)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "服务暂不可用", "internal")
		return
	}
	h.copyFrom(w, r, user, org, title, id, true)
}

func (h Host) copyFrom(w http.ResponseWriter, r *http.Request, user, org int64, title, id string, useBodyTitle bool) {
	item, err := h.loadCard(r, org, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "上架方案不存在", "not_found")
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	if item.supplier {
		writeErr(w, http.StatusBadRequest, "供应商商品方案是唯一软链接，不能复制", "validation")
		return
	}
	body, err := PrepareCard(item.payload, defaultsOf(item.payload))
	if err != nil {
		writeDoc(w, err)
		return
	}
	next := item.view.Title
	if useBodyTitle && strings.TrimSpace(title) != "" {
		next = strings.TrimSpace(title)
	}
	store := ""
	if item.view.StoreID != nil {
		store = *item.view.StoreID
	}
	if store != "" {
		if _, ok := h.visibleStore(w, r, org, user, &store); !ok {
			return
		}
	}
	created, err := h.insertCard(r, org, user, next, store, body, false)
	if err != nil {
		writeDB(w, err)
		return
	}
	writeCard(w, created)
}

func (h Host) insertCard(r *http.Request, org, user int64, title, store string, payload []byte, _ bool) (cardRow, error) {
	id := uuid.NewString()
	var item cardRow
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), `
			INSERT INTO listing_cards (id, org_id, title, store_id, payload, created_by, updated_by)
			VALUES ($1::uuid, $2, $3, NULLIF($4, '')::uuid, $5::jsonb, NULLIF($6, 0), NULLIF($6, 0))
			RETURNING `+cardSelect, id, org, title, store, string(payload), user)
		scanned, err := scanCard(row)
		if err != nil {
			return err
		}
		item = scanned
		return nil
	})
	return item, err
}

func (h Host) visibleStore(w http.ResponseWriter, r *http.Request, org, user int64, store *string) (string, bool) {
	if store == nil {
		return "", true
	}
	trimmed := strings.TrimSpace(*store)
	if trimmed == "" {
		return "", true
	}
	id, ok := CanonicalUUID(trimmed)
	if !ok {
		writeErr(w, http.StatusBadRequest, "storeId 不是有效的店铺标识", "validation")
		return "", false
	}
	var manual, suspended bool
	var assignee *int64
	var membership *int64
	var role *string
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT s.manual_disabled, s.quota_suspended, s.assignee_membership_id, m.id, m.role
			FROM organization_stores s
			LEFT JOIN organization_members m
			  ON m.org_id = s.org_id AND m.user_id = $3
			 AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
			WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
			LIMIT 1`, org, id, user).Scan(&manual, &suspended, &assignee, &membership, &role)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return "", false
	}
	if err != nil {
		writeDB(w, err)
		return "", false
	}
	if membership == nil {
		writeErr(w, http.StatusForbidden, "工作空间成员当前不可用", "forbidden")
		return "", false
	}
	if !storeVisible(roleString(role), assignee, *membership) {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return "", false
	}
	_ = manual
	_ = suspended
	return id, true
}

func storeVisible(role string, assignee *int64, membership int64) bool {
	parsed, ok := access.ParseWorkspace(role)
	if !ok {
		return false
	}
	if parsed == "owner" || parsed == "manager" {
		return true
	}
	return assignee != nil && *assignee == membership
}

func roleString(role *string) string {
	if role == nil {
		return ""
	}
	return *role
}

func writeDoc(w http.ResponseWriter, err error) {
	var doc DocError
	if errors.As(err, &doc) {
		status := http.StatusBadRequest
		code := "validation"
		if doc.Kind == "conflict" {
			status = http.StatusConflict
			code = "conflict"
		}
		writeErr(w, status, doc.Message, code)
		return
	}
	writeErr(w, http.StatusBadRequest, err.Error(), "validation")
}

func writeDB(w http.ResponseWriter, err error) {
	status, message, code := dbStatus(err)
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "1")
	}
	writeErr(w, status, message, code)
}

func writeCard(w http.ResponseWriter, item cardRow) {
	jsonwire.Write(w, http.StatusOK, struct {
		Data cardView `json:"data"`
	}{Data: item.view})
}

func defaultsOf(payload []byte) json.RawMessage {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil
	}
	return body["defaults"]
}
