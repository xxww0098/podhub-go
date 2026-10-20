package cataloghttp

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/catalog/domain"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) visibleStore(w http.ResponseWriter, r *http.Request, p access.Principal, storeID string) bool {
	if _, ok := domainUUID(storeID); !ok {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return false
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return false
	}
	var assignee *int64
	var membershipID *int64
	var role *string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT s.assignee_membership_id, m.id, m.role
		FROM organization_stores s
		LEFT JOIN organization_members m
		  ON m.org_id = s.org_id AND m.user_id = $3 AND m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended
		WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
		LIMIT 1`, p.OrgID, storeID, p.UserID).Scan(&assignee, &membershipID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return false
	}
	if err != nil {
		slog.Error("catalog store", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return false
	}
	if membershipID == nil || role == nil || strings.TrimSpace(*role) == "" {
		writeErr(w, http.StatusForbidden, "工作空间成员当前不可用", "forbidden")
		return false
	}
	if !access.StoreVisible(*role, assignee, *membershipID) {
		writeErr(w, http.StatusNotFound, "Store 不存在", "not_found")
		return false
	}
	return true
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

func (h Host) schema(w http.ResponseWriter, r *http.Request) {
	p, ok := h.account(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	category, typeID, ok := positivePair(q.Get("description_category_id"), q.Get("type_id"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "请选择有效的类目", "validation")
		return
	}
	language, ok := LanguageKey(q.Get("language"))
	if !q.Has("language") || !ok {
		writeErr(w, http.StatusBadRequest, "language 无效", "validation")
		return
	}
	storeID := strings.TrimSpace(q.Get("store_id"))
	if storeID != "" && !h.visibleStore(w, r, p, storeID) {
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	var payload []byte
	var fetched int64
	err := h.Pool.QueryRow(r.Context(), `
		SELECT payload, fetched_at_ms FROM public.ozon_catalog_schema_cache
		WHERE description_category_id = $1 AND type_id = $2 AND language = $3`,
		category, typeID, language).Scan(&payload, &fetched)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Error("catalog schema", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if err == nil && Fresh(h.Now(), fetched) {
		fields, decErr := domain.DecodeSchemaFields(payload)
		if decErr != nil {
			writeErr(w, http.StatusInternalServerError, "类目字段缓存损坏，请稍后重试", "internal")
			return
		}
		h.writeSchemaMaterial(w, r, category, typeID, language, fetched, fields)
		return
	}
	if err == nil {
		if _, delErr := h.Pool.Exec(r.Context(), `
			DELETE FROM public.ozon_catalog_schema_cache
			WHERE description_category_id = $1 AND type_id = $2 AND language = $3 AND fetched_at_ms = $4`,
			category, typeID, language, fetched); delErr != nil {
			slog.Error("catalog schema delete", "err", delErr)
			writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
			return
		}
	}
	var usable bool
	if err := h.Pool.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM public.platform_catalog_fetch_keys
			WHERE api_key_nonce IS NOT NULL AND api_key_ciphertext IS NOT NULL AND disabled_at_ms IS NULL
		)`).Scan(&usable); err != nil {
		slog.Error("catalog schema keys", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	if !usable {
		jsonwire.Write(w, http.StatusOK, nil)
		return
	}
	h.fillSchema(w, r, category, typeID, language)
}

type schemaData struct {
	DescriptionCategoryID int64           `json:"description_category_id"`
	TypeID                int64           `json:"type_id"`
	Language              string          `json:"language"`
	FetchedAtMs           int64           `json:"fetched_at_ms"`
	Fields                json.RawMessage `json:"fields"`
}

func positivePair(category, typeID string) (int64, int64, bool) {
	c, errC := strconv.ParseInt(category, 10, 64)
	t, errT := strconv.ParseInt(typeID, 10, 64)
	if errC != nil || errT != nil || c <= 0 || t <= 0 {
		return 0, 0, false
	}
	return c, t, true
}

func (h Host) fetchConfig(w http.ResponseWriter, r *http.Request) {
	p, ok := h.account(w, r)
	if !ok {
		return
	}
	if status, message, allowed := access.SuperAdmin(p); !allowed {
		writeErr(w, status, message, "forbidden")
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	view, err := h.loadFetchConfig(r)
	if err != nil {
		slog.Error("catalog fetch config", "err", err)
		writeErr(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return
	}
	jsonwire.Write(w, http.StatusOK, view)
}

type fetchKey struct {
	ClientID         string `json:"client_id"`
	APIKeyConfigured bool   `json:"api_key_configured"`
	Disabled         bool   `json:"disabled"`
}

type fetchWB struct {
	Configured         bool   `json:"configured"`
	CredentialRevision int64  `json:"credential_revision"`
	LastVerifiedAtMs   *int64 `json:"last_verified_at_ms"`
}

type fetchFreshness struct {
	Total   int64 `json:"total"`
	Fresh   int64 `json:"fresh"`
	Stale   int64 `json:"stale"`
	Expired int64 `json:"expired"`
	Missing int64 `json:"missing"`
}

type fetchView struct {
	Enabled             bool           `json:"enabled"`
	ScheduleMode        string         `json:"schedule_mode"`
	AtMinute            int32          `json:"at_minute"`
	WindowStartMinute   int32          `json:"window_start_minute"`
	WindowEndMinute     int32          `json:"window_end_minute"`
	UTCOffsetMinutes    int32          `json:"utc_offset_minutes"`
	Language            string         `json:"language"`
	Keys                []fetchKey     `json:"keys"`
	WBCredential        fetchWB        `json:"wb_credential"`
	NextRunAtMs         *int64         `json:"next_run_at_ms"`
	LastRunAtMs         *int64         `json:"last_run_at_ms"`
	LastStatus          *string        `json:"last_status"`
	LastError           string         `json:"last_error"`
	LastDurationMs      *int64         `json:"last_duration_ms"`
	LastRootNodes       *int64         `json:"last_root_nodes"`
	LastKeyClientID     *string        `json:"last_key_client_id"`
	LastKeyAttempts     int32          `json:"last_key_attempts"`
	FailureStreak       int32          `json:"failure_streak"`
	Running             bool           `json:"running"`
	CoordinateFreshness fetchFreshness `json:"coordinate_freshness"`
	UpdatedAtMs         int64          `json:"updated_at_ms"`
}

func (h Host) loadFetchConfig(r *http.Request) (fetchView, error) {
	view := fetchView{
		ScheduleMode: "fixed", AtMinute: domain.FetchAtMinute,
		WindowStartMinute: domain.FetchWindowStart, WindowEndMinute: domain.FetchWindowEnd,
		UTCOffsetMinutes: domain.FetchUTCOffset, Language: domain.FetchLanguage,
		Keys: []fetchKey{}, WBCredential: fetchWB{}, LastError: "",
	}
	var lease *int64
	err := h.Pool.QueryRow(r.Context(), `
		SELECT enabled, schedule_mode, at_minute, window_start_minute, window_end_minute, utc_offset_minutes,
		       language, next_run_at_ms, last_run_at_ms, last_status, last_error, last_duration_ms, last_root_nodes,
		       last_key_client_id, last_key_attempts, failure_streak, updated_at_ms, lease_until_ms,
		       (wb_token_nonce IS NOT NULL AND wb_token_ciphertext IS NOT NULL), wb_credential_revision, wb_last_verified_at_ms
		FROM public.platform_catalog_fetch_config WHERE singleton = true`).Scan(
		&view.Enabled, &view.ScheduleMode, &view.AtMinute, &view.WindowStartMinute, &view.WindowEndMinute,
		&view.UTCOffsetMinutes, &view.Language, &view.NextRunAtMs, &view.LastRunAtMs, &view.LastStatus,
		&view.LastError, &view.LastDurationMs, &view.LastRootNodes, &view.LastKeyClientID, &view.LastKeyAttempts,
		&view.FailureStreak, &view.UpdatedAtMs, &lease, &view.WBCredential.Configured, &view.WBCredential.CredentialRevision,
		&view.WBCredential.LastVerifiedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return fetchView{}, err
	}
	view.Running = domain.FetchRunning(lease, h.Now())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT client_id,
		       (api_key_nonce IS NOT NULL AND api_key_ciphertext IS NOT NULL),
		       disabled_at_ms IS NOT NULL
		FROM public.platform_catalog_fetch_keys
		ORDER BY position`)
	if err != nil {
		return fetchView{}, err
	}
	defer rows.Close()
	view.Keys = []fetchKey{}
	for rows.Next() {
		var key fetchKey
		if err := rows.Scan(&key.ClientID, &key.APIKeyConfigured, &key.Disabled); err != nil {
			return fetchView{}, err
		}
		view.Keys = append(view.Keys, key)
	}
	if err := rows.Err(); err != nil {
		return fetchView{}, err
	}
	language := view.Language
	if language == "" {
		language = domain.FetchLanguage
	}
	freshRows, err := h.Pool.Query(r.Context(), `
		SELECT cat.fetched_at_ms
		FROM (SELECT DISTINCT description_category_id, type_id
		      FROM public.sc_products
		      WHERE NOT archived AND description_category_id > 0 AND type_id > 0
		      ORDER BY description_category_id, type_id
		      LIMIT $1) AS refs
		LEFT JOIN public.ozon_category_current cat
		  ON cat.description_category_id = refs.description_category_id
		 AND cat.type_id = refs.type_id
		 AND cat.language = $2`, domain.FreshnessSample, language)
	if err != nil {
		return fetchView{}, err
	}
	defer freshRows.Close()
	now := h.Now().UnixMilli()
	for freshRows.Next() {
		var fetched *int64
		if err := freshRows.Scan(&fetched); err != nil {
			return fetchView{}, err
		}
		view.CoordinateFreshness.Total++
		switch domain.FreshnessBand(fetched, now) {
		case "fresh":
			view.CoordinateFreshness.Fresh++
		case "stale":
			view.CoordinateFreshness.Stale++
		case "expired":
			view.CoordinateFreshness.Expired++
		default:
			view.CoordinateFreshness.Missing++
		}
	}
	return view, freshRows.Err()
}

func (h Host) wbSubject(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.account(w, r); !ok {
		return
	}
	q := r.URL.Query()
	unknown := false
	for key := range q {
		if key != "language" {
			unknown = true
		}
	}
	language := ""
	if values := q["language"]; len(values) == 1 {
		language = values[0]
	} else if len(values) > 1 {
		unknown = true
	}
	subject, lang, msg, ok := domain.AcceptWBQuery(chi.URLParam(r, "subject_id"), r.URL.RawQuery, language, unknown)
	if !ok {
		writeErr(w, http.StatusBadRequest, msg, "validation")
		return
	}
	if h.Pool == nil {
		writeErr(w, http.StatusInternalServerError, "WB 类目材料读取失败；保留当前预览，请稍后显式刷新该类目", "internal")
		return
	}
	var parentID int64
	var subjectName, parentName, digest string
	var fields json.RawMessage
	var fetched int64
	var characteristics json.RawMessage
	var revision *int64
	var validated *string
	err := h.Pool.QueryRow(r.Context(), `
		SELECT c.parent_id, c.subject_name, c.parent_name, c.fields, c.content_digest, c.fetched_at_ms,
		       d.characteristics, d.revision, d.validated_catalog_digest
		FROM public.wb_category_current AS c
		LEFT JOIN public.wb_category_field_defaults AS d USING (subject_id, language)
		WHERE c.subject_id = $1 AND c.language = $2
		LIMIT 1`, subject, lang).Scan(
		&parentID, &subjectName, &parentName, &fields, &digest, &fetched, &characteristics, &revision, &validated)
	if errors.Is(err, pgx.ErrNoRows) {
		writeWB(w, subject, lang, nil, nil, domain.WBIssues(false, false, false, false))
		return
	}
	if err != nil {
		slog.Error("wb subject", "err", err)
		writeErr(w, http.StatusInternalServerError, "WB 类目材料读取失败；保留当前预览，请稍后显式刷新该类目", "internal")
		return
	}
	now := h.Now().UnixMilli()
	usable := domain.CatalogUsable(fetched, now)
	hasDefaults := revision != nil && validated != nil
	match := hasDefaults && *validated == digest
	issues := domain.WBIssues(true, usable, hasDefaults, match)
	catalog := &wbCatalog{
		ParentID: parentID, SubjectName: subjectName, ParentName: parentName, Fields: fields,
		ContentDigest: digest, FetchedAtMs: fetched, ExpiresAtMs: fetched + domain.WBMaxAgeMs, Usable: usable,
	}
	var defaults *wbDefaults
	if hasDefaults {
		rev := *revision
		defaults = &wbDefaults{
			Values: characteristics, Revision: rev, ValidatedCatalogDigest: *validated, Usable: usable && match,
		}
	}
	writeWB(w, subject, lang, catalog, defaults, issues)
}

type wbCatalog struct {
	ParentID      int64           `json:"parent_id"`
	SubjectName   string          `json:"subject_name"`
	ParentName    string          `json:"parent_name"`
	Fields        json.RawMessage `json:"fields"`
	ContentDigest string          `json:"content_digest"`
	FetchedAtMs   int64           `json:"fetched_at_ms"`
	ExpiresAtMs   int64           `json:"expires_at_ms"`
	Usable        bool            `json:"usable"`
}

type wbDefaults struct {
	Values                 json.RawMessage `json:"values"`
	Revision               int64           `json:"revision"`
	ValidatedCatalogDigest string          `json:"validated_catalog_digest"`
	Usable                 bool            `json:"usable"`
}

type wbIssue struct {
	Key struct {
		Platform string `json:"platform"`
		Stage    string `json:"stage"`
		Code     string `json:"code"`
	} `json:"key"`
	Field            string `json:"field"`
	Scope            string `json:"scope"`
	CharacteristicID *int64 `json:"characteristic_id"`
}

func writeWB(w http.ResponseWriter, subject int64, language string, catalog *wbCatalog, defaults *wbDefaults, issues []domain.WBIssue) {
	wire := make([]wbIssue, len(issues))
	for i, issue := range issues {
		wire[i].Key.Platform = "wb"
		wire[i].Key.Stage = "metadata"
		wire[i].Key.Code = issue.Code
		wire[i].Field = issue.Field
		wire[i].Scope = "material"
	}
	if wire == nil {
		wire = []wbIssue{}
	}
	jsonwire.Write(w, http.StatusOK, struct {
		SubjectID int64       `json:"subject_id"`
		Language  string      `json:"language"`
		Catalog   *wbCatalog  `json:"catalog"`
		Defaults  *wbDefaults `json:"defaults"`
		Usable    bool        `json:"usable"`
		Issues    []wbIssue   `json:"issues"`
	}{SubjectID: subject, Language: language, Catalog: catalog, Defaults: defaults, Usable: len(issues) == 0, Issues: wire})
}
