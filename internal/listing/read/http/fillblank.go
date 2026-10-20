package readhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// crossOriginWrite is identity.CrossOriginWrite. listing/read/http cannot import
// internal/identity; the cookie, site, and origin rule is the same one.
func crossOriginWrite(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	if !sessionCookiePresent(r.Header.Get("Cookie")) {
		return false
	}
	if site := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")); site != "" {
		return site != "same-origin" && site != "none"
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	auth, ok := originAuthority(origin)
	if !ok || strings.TrimSpace(r.Host) == "" {
		return true
	}
	return auth != strings.TrimSpace(r.Host)
}

func sessionCookiePresent(cookies string) bool {
	for _, part := range strings.Split(cookies, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if (name == "sid" || name == "sids") && value != "" {
			return true
		}
	}
	return false
}

func originAuthority(origin string) (string, bool) {
	scheme, rest, ok := strings.Cut(origin, "://")
	if !ok || scheme == "" || rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func writeCSRF(w http.ResponseWriter) {
	jsonwire.Write(w, http.StatusForbidden, struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: "csrf_rejected", Message: "跨站请求已被拒绝"})
}

func jsonNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

func jsonObject(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && raw[0] == '{'
}

func fieldSome(fields map[string]json.RawMessage, key string) bool {
	raw, ok := fields[key]
	return ok && !jsonNull(raw)
}

func flagTrue(fields map[string]json.RawMessage, key string) bool {
	raw, ok := fields[key]
	if !ok || jsonNull(raw) {
		return false
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	return value
}

func patchTypesOK(fields map[string]json.RawMessage) bool {
	for _, key := range []string{"fillBlank", "clearGeneratedContent"} {
		raw, ok := fields[key]
		if !ok {
			continue
		}
		if jsonNull(raw) {
			return false
		}
		var value bool
		if json.Unmarshal(raw, &value) != nil {
			return false
		}
	}
	if raw, ok := fields["candidateDecisions"]; ok && !jsonNull(raw) {
		var rows []json.RawMessage
		if json.Unmarshal(raw, &rows) != nil {
			return false
		}
	}
	if raw, ok := fields["storeId"]; ok && !jsonNull(raw) {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return false
		}
	}
	return true
}

func fillExclusion(fields map[string]json.RawMessage) string {
	decisions := fieldSome(fields, "candidateDecisions")
	fill := flagTrue(fields, "fillBlank")
	clear := flagTrue(fields, "clearGeneratedContent")
	payload := fieldSome(fields, "payload")
	changes := fieldSome(fields, "changes")
	draft := fieldSome(fields, "draft")
	_, store := fields["storeId"]
	if decisions && (clear || payload || changes || draft || fill || store) {
		return "候选确认不能与其他字段写入一起提交"
	}
	if clear && (payload || changes || draft || fill || store) {
		return "清空生成内容不能与其他字段写入一起提交"
	}
	return ""
}

func clientChanges(fields map[string]json.RawMessage) (json.RawMessage, bool) {
	if raw, ok := fields["changes"]; ok && !jsonNull(raw) {
		if !jsonObject(raw) {
			return nil, false
		}
		return raw, true
	}
	if raw, ok := fields["payload"]; ok && !jsonNull(raw) {
		if !jsonObject(raw) {
			return nil, false
		}
		return raw, true
	}
	return json.RawMessage(`{}`), true
}

type fillConflict struct {
	revision int64
	payload  []byte
	base     int64
	changes  json.RawMessage
	editor   *int64
}

func (fillConflict) Error() string { return "conflict" }

const fillBlankSQL = `
UPDATE listing_rows
   SET
     payload = (
       SELECT COALESCE(jsonb_object_agg(key, val), '{}'::jsonb)
       FROM (
         SELECT e.key AS key,
                CASE
                  WHEN f.key IS NOT NULL AND (
                    e.value IS NULL
                    OR e.value = 'null'::jsonb
                    OR (jsonb_typeof(e.value) = 'string'
                        AND COALESCE(e.value #>> '{}', '') = '')
                  )
                  THEN f.value
                  ELSE e.value
                END AS val
         FROM jsonb_each(listing_rows.payload) AS e(key, value)
         LEFT JOIN jsonb_each($4::jsonb) AS f(key, value)
           ON e.key = f.key
         UNION ALL
         SELECT f.key, f.value
         FROM jsonb_each($4::jsonb) AS f(key, value)
         WHERE NOT (listing_rows.payload ? f.key)
       ) AS merged(key, val)
     ),
     build_state = 'stale',
     revision = revision + 1,
     updated_at = clock_timestamp()
   WHERE org_id = $1
     AND id = $2::uuid
     AND revision = $3
   RETURNING id::text`

func (h Host) fillBlankRow(w http.ResponseWriter, r *http.Request, p access.Principal, id string, base int64, fields map[string]json.RawMessage) {
	doc, ok := clientChanges(fields)
	if !ok {
		writeErr(w, http.StatusBadRequest, "changes/payload 必须是对象", "validation")
		return
	}
	payloadSome := fieldSome(fields, "payload")
	changesSome := fieldSome(fields, "changes")
	storeSet := false
	storeID := ""
	storeLookup := false
	if raw, exists := fields["storeId"]; exists {
		storeSet = true
		if !jsonNull(raw) {
			var text string
			if json.Unmarshal(raw, &text) != nil {
				writeErr(w, http.StatusBadRequest, "请求格式无效", "validation")
				return
			}
			text = strings.TrimSpace(text)
			if text != "" {
				bound, good := CanonicalUUID(text)
				if !good {
					writeErr(w, http.StatusBadRequest, "storeId 不是有效的店铺标识", "validation")
					return
				}
				storeID = bound
				storeLookup = true
			}
		}
	}
	var item storedScan
	err := h.withOrg(r.Context(), p.OrgID, func(tx pgx.Tx) error {
		var (
			revision int64
			payload  []byte
			store    *string
			editor   *int64
		)
		err := tx.QueryRow(r.Context(), `
			SELECT revision, payload, store_id::text, updated_by
			FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id).
			Scan(&revision, &payload, &store, &editor)
		if errors.Is(err, pgx.ErrNoRows) {
			return rowRefuse{http.StatusNotFound, "商品行不存在", "not_found"}
		}
		if err != nil {
			return err
		}
		if msg := domain.ProtectContentSections(payload, doc, payloadSome, false); msg != "" {
			return rowRefuse{http.StatusBadRequest, msg, "validation"}
		}
		merged, msg := domain.AuthoringMediaChanges(payload, doc, payloadSome)
		if msg != "" {
			return rowRefuse{http.StatusBadRequest, msg, "validation"}
		}
		doc = merged
		if storeLookup {
			if err := h.requireStore(r, tx, p.OrgID, p.UserID, storeID); err != nil {
				return err
			}
		}
		current := ""
		if store != nil {
			current = *store
		}
		moved := storeSet && !strings.EqualFold(current, storeID)
		if storeSet && !changesSome && !payloadSome {
			tag, err := tx.Exec(r.Context(), `
				UPDATE listing_rows
				SET store_id = NULLIF($4, '')::uuid,
				    revision = revision + 1,
				    updated_by = NULLIF($5, 0),
				    updated_at = clock_timestamp()
				WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
				p.OrgID, id, base, storeID, p.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return conflictAt(r, tx, p.OrgID, id, base, doc)
			}
			if moved {
				if err := applyInvalidation(r, tx, p.OrgID, id, domain.TriggerStore); err != nil {
					return err
				}
			}
			item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
			return err
		}
		triggers := domain.TriggersForChanges(doc, true)
		needPrev := payloadSome || domain.HasTrigger(triggers, domain.TriggerSource)
		var written string
		err = tx.QueryRow(r.Context(), fillBlankSQL, p.OrgID, id, base, string(domain.StripSchemaReference(doc))).Scan(&written)
		if errors.Is(err, pgx.ErrNoRows) {
			return conflictAt(r, tx, p.OrgID, id, base, doc)
		}
		if err != nil {
			return err
		}
		var newRev int64
		var newPayload []byte
		if err := tx.QueryRow(r.Context(), `
			SELECT revision, payload FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id).
			Scan(&newRev, &newPayload); err != nil {
			return err
		}
		if needPrev {
			triggers = domain.WithoutTrigger(triggers, domain.TriggerSource)
			if domain.SourceChanged(payload, newPayload) {
				triggers = append(triggers, domain.TriggerSource)
				overlay, err := domain.InvalidateSourceContent(newPayload, payload)
				if err != nil {
					return rowRefuse{http.StatusBadRequest, "商品行载荷不是可校验的上架文档：" + err.Error(), "validation"}
				}
				tag, err := tx.Exec(r.Context(), `
					UPDATE listing_rows SET payload = payload || $4::jsonb
					WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
					p.OrgID, id, newRev, string(overlay))
				if err != nil {
					return err
				}
				if tag.RowsAffected() != 1 {
					return conflictAt(r, tx, p.OrgID, id, base, doc)
				}
			}
		}
		if moved && !domain.HasTrigger(triggers, domain.TriggerStore) {
			triggers = append(triggers, domain.TriggerStore)
		}
		for _, trigger := range triggers {
			if err := applyInvalidation(r, tx, p.OrgID, id, trigger); err != nil {
				return err
			}
		}
		if moved {
			tag, err := tx.Exec(r.Context(), `
				UPDATE listing_rows
				SET store_id = NULLIF($4, '')::uuid,
				    revision = revision + 1,
				    updated_by = NULLIF($5, 0),
				    updated_at = clock_timestamp()
				WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
				p.OrgID, id, newRev, storeID, p.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return conflictAt(r, tx, p.OrgID, id, base, doc)
			}
		}
		item, err = scanStoredRow(tx.QueryRow(r.Context(), `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, p.OrgID, id))
		return err
	})
	var refused rowRefuse
	if errors.As(err, &refused) {
		writeErr(w, refused.status, refused.message, refused.code)
		return
	}
	var conflict fillConflict
	if errors.As(err, &conflict) {
		writeFillConflict(w, conflict)
		return
	}
	if err != nil {
		writeDB(w, err)
		return
	}
	item.row.Payload = dropSchemaSnapshot(item.row.Payload)
	view := ProjectRow(item.row)
	issues := view.ValidationIssues
	if len(bytes.TrimSpace(issues)) == 0 {
		issues = json.RawMessage(`[]`)
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data   RowView         `json:"data"`
		Issues json.RawMessage `json:"issues"`
	}{Data: view, Issues: issues})
}

func (h Host) requireStore(r *http.Request, tx pgx.Tx, org, user int64, id string) error {
	var manual, suspended bool
	var assignee *int64
	var membership *int64
	var role *string
	err := tx.QueryRow(r.Context(), `
		SELECT s.manual_disabled, s.quota_suspended, s.assignee_membership_id, m.id, m.role
		FROM organization_stores s
		LEFT JOIN organization_members m
		  ON m.org_id = s.org_id AND m.user_id = $3
		 AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
		WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
		LIMIT 1`, org, id, user).Scan(&manual, &suspended, &assignee, &membership, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return rowRefuse{http.StatusNotFound, "Store 不存在", "not_found"}
	}
	if err != nil {
		return err
	}
	if membership == nil {
		return rowRefuse{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
	}
	if !storeVisible(roleString(role), assignee, *membership) {
		return rowRefuse{http.StatusNotFound, "Store 不存在", "not_found"}
	}
	_ = manual
	_ = suspended
	return nil
}

func applyInvalidation(r *http.Request, tx pgx.Tx, org int64, id string, trigger domain.Trigger) error {
	overlay := domain.OverlayOf(trigger)
	_, err := tx.Exec(r.Context(), `
		UPDATE listing_rows
		   SET validation_state = $6,
		       content_state = COALESCE($3, content_state),
		       media_state = COALESCE($4, media_state),
		       submission_state = COALESCE($5, submission_state),
		       updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid`,
		org, id, overlay.Content, overlay.Media, overlay.Submission, "stale")
	return err
}

func conflictAt(r *http.Request, tx pgx.Tx, org int64, id string, base int64, changes json.RawMessage) error {
	var revision int64
	var payload []byte
	var editor *int64
	err := tx.QueryRow(r.Context(), `
		SELECT revision, payload, updated_by
		FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, org, id).
		Scan(&revision, &payload, &editor)
	if errors.Is(err, pgx.ErrNoRows) {
		return rowRefuse{http.StatusNotFound, "商品行不存在", "not_found"}
	}
	if err != nil {
		return err
	}
	return fillConflict{revision: revision, payload: payload, base: base, changes: changes, editor: editor}
}

func writeFillConflict(w http.ResponseWriter, conflict fillConflict) {
	server := json.RawMessage(conflict.payload)
	if !json.Valid(server) || len(bytes.TrimSpace(server)) == 0 {
		server = json.RawMessage(`{}`)
	}
	changes := conflict.changes
	if len(bytes.TrimSpace(changes)) == 0 {
		changes = json.RawMessage(`{}`)
	}
	body := struct {
		Error    string `json:"error"`
		Code     string `json:"code"`
		Conflict struct {
			ServerRevision     int64           `json:"serverRevision"`
			ServerPayload      json.RawMessage `json:"serverPayload"`
			ClientBaseRevision int64           `json:"clientBaseRevision"`
			ClientChanges      json.RawMessage `json:"clientChanges"`
			LastEditorID       *int64          `json:"lastEditorId,omitempty"`
		} `json:"conflict"`
	}{
		Error: "商品行已被他人更新，请刷新后重试",
		Code:  "conflict",
	}
	body.Conflict.ServerRevision = conflict.revision
	body.Conflict.ServerPayload = server
	body.Conflict.ClientBaseRevision = conflict.base
	body.Conflict.ClientChanges = changes
	body.Conflict.LastEditorID = conflict.editor
	jsonwire.Write(w, http.StatusConflict, body)
}

func dropSchemaSnapshot(payload []byte) []byte {
	var body map[string]json.RawMessage
	if json.Unmarshal(payload, &body) != nil || body == nil {
		return payload
	}
	delete(body, "schemaSnapshot")
	out, err := json.Marshal(body)
	if err != nil {
		return payload
	}
	return out
}
