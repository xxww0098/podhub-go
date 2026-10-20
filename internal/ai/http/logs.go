package aihttp

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/newapibilling"
)

const (
	logTypeConsume = 2
	logPageDefault = 20
	logPageMax     = 100
	logExportMax   = 10_000
	logPageLimit   = 100_000
)

type consumeLog struct {
	OrgID      int64
	RequestID  int64
	UserID     int64
	CreatedAt  int64
	Content    string
	Username   string
	Model      string
	Quota      int
	Prompt     int
	Completion int
	UseTime    int
	Group      string
	IP         string
	PublicID   string
	UpstreamID string
	Other      []byte
}

func insertConsumeLog(ctx context.Context, tx pgx.Tx, row consumeLog) error {
	if err := tenantx.EnterApp(ctx, tx, row.OrgID); err != nil {
		return err
	}
	if row.Other == nil {
		row.Other = []byte(`{}`)
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO ai_consume_logs (
		    org_id, ai_request_id, user_id, created_at, type, content, username,
		    token_name, model_name, quota, prompt_tokens, completion_tokens,
		    use_time, is_stream, channel, token_id, "group", ip, request_id,
		    upstream_request_id, other)
		SELECT $1, $2, $3, $4, $5, $6, $7, '', $8, $9, $10, $11, $12, false, 0, 0,
		       $13, $14, $15, $16, $17::jsonb
		 WHERE NOT EXISTS (
		    SELECT 1 FROM ai_consume_logs WHERE org_id = $1 AND ai_request_id = $2)`,
		row.OrgID, row.RequestID, row.UserID, row.CreatedAt, logTypeConsume, row.Content, row.Username,
		row.Model, row.Quota, row.Prompt, row.Completion, row.UseTime, row.Group, row.IP,
		fitWidth(row.PublicID, 64), fitWidth(row.UpstreamID, 128), string(row.Other))
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 1 {
		return fmt.Errorf("consume log inserted %d rows", tag.RowsAffected())
	}
	return nil
}

// fitWidth limits PostgreSQL varchar(n) values by characters, not UTF-8 bytes.
func fitWidth(s string, n int) string {
	if n <= 0 {
		return ""
	}
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}

type logQuery struct {
	Type       *int
	Start      *int64
	End        *int64
	Model      string
	Token      string
	Group      string
	RequestID  string
	UpstreamID string
	Username   string
	Channel    *int
	Page       int
	PageSize   int
	Manager    bool
}

func (h httpHandler) logs(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	q, err := parseLogQuery(r, true)
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
		return
	}
	q.Manager = access.CanManage(principal.WorkspaceRole)
	if h.deps.Pool == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	items, total, err := listLogs(r.Context(), h.deps.Pool.Begin, principal.OrgID, q)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if items == nil {
		items = []logItem{}
	}
	writeJSON(w, 200, map[string]any{
		"page": q.Page, "page_size": q.PageSize, "total": total, "items": items,
	})
}

func (h httpHandler) logStat(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	q, err := parseLogQuery(r, false)
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
		return
	}
	q.Manager = access.CanManage(principal.WorkspaceRole)
	if h.deps.Pool == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	stat, err := statLogs(r.Context(), h.deps.Pool.Begin, principal.OrgID, q, time.Now().Unix())
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	writeJSON(w, 200, stat)
}

func (h httpHandler) logExport(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	q, err := parseLogQuery(r, false)
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "请求格式无效"))
		return
	}
	q.Manager = access.CanManage(principal.WorkspaceRole)
	if h.deps.Pool == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	tx, err := tenantx.BeginApp(r.Context(), h.deps.Pool.Begin, principal.OrgID)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer tx.Rollback(r.Context())
	var locked bool
	if err := tx.QueryRow(r.Context(), `
		SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`,
		fmt.Sprintf("ai-consume-log-export:%d", principal.UserID)).Scan(&locked); err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if !locked {
		writeResp(w, fail(429, "BUSY", "已有导出正在进行"))
		return
	}
	where, args := logWhere(principal.OrgID, q)
	var n int64
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM ai_consume_logs WHERE `+where, args...).Scan(&n); err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if n > logExportMax {
		writeResp(w, fail(400, "VALIDATION", "导出结果超过 10000 行，请缩小时间范围"))
		return
	}
	rows, err := tx.Query(r.Context(), `
		SELECT id, created_at, type, username, token_name, model_name, quota,
		       prompt_tokens, completion_tokens, use_time, is_stream, channel,
		       "group", ip, request_id, upstream_request_id, content, other
		  FROM ai_consume_logs WHERE `+where+` ORDER BY created_at DESC, id DESC`, args...)
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="ai-logs.csv"`)
	w.WriteHeader(http.StatusOK)
	cw := csv.NewWriter(w)
	header := []string{
		"id", "created_at", "type", "username", "token_name", "model_name", "quota",
		"prompt_tokens", "completion_tokens", "use_time", "is_stream", "channel",
		"group", "ip", "request_id", "upstream_request_id", "content", "other",
	}
	if err := cw.Write(csvSafeRow(header)); err != nil {
		return
	}
	flusher, _ := w.(http.Flusher)
	for rows.Next() {
		var item logItem
		var stream bool
		var other []byte
		if err := rows.Scan(&item.ID, &item.CreatedAt, &item.Type, &item.Username, &item.TokenName,
			&item.ModelName, &item.Quota, &item.PromptTokens, &item.Completion, &item.UseTime,
			&stream, &item.Channel, &item.Group, &item.IP, &item.RequestID, &item.UpstreamID, &item.Content, &other); err != nil {
			return
		}
		if !q.Manager {
			item.Channel = 0
			item.IP = ""
		}
		if err := cw.Write(csvSafeRow([]string{
			strconv.FormatInt(item.ID, 10), strconv.FormatInt(item.CreatedAt, 10), strconv.Itoa(item.Type),
			item.Username, item.TokenName, item.ModelName, strconv.FormatInt(item.Quota, 10),
			strconv.Itoa(item.PromptTokens), strconv.Itoa(item.Completion), strconv.Itoa(item.UseTime),
			strconv.FormatBool(stream), strconv.Itoa(item.Channel), item.Group, item.IP,
			item.RequestID, item.UpstreamID, item.Content, string(stripOther(other, q.Manager)),
		})); err != nil {
			return
		}
		cw.Flush()
		if flusher != nil {
			flusher.Flush()
		}
	}
	cw.Flush()
	_ = tx.Commit(r.Context())
}

type logItem struct {
	ID           int64           `json:"id"`
	UserID       int64           `json:"user_id"`
	CreatedAt    int64           `json:"created_at"`
	Type         int             `json:"type"`
	Content      string          `json:"content"`
	Username     string          `json:"username"`
	TokenName    string          `json:"token_name"`
	ModelName    string          `json:"model_name"`
	Quota        int64           `json:"quota"`
	PromptTokens int             `json:"prompt_tokens"`
	Completion   int             `json:"completion_tokens"`
	UseTime      int             `json:"use_time"`
	IsStream     bool            `json:"is_stream"`
	Channel      int             `json:"channel"`
	TokenID      int64           `json:"token_id"`
	Group        string          `json:"group"`
	IP           string          `json:"ip"`
	RequestID    string          `json:"request_id"`
	UpstreamID   string          `json:"upstream_request_id"`
	Other        json.RawMessage `json:"other"`
}

type logStat struct {
	Quota int64 `json:"quota"`
	RPM   int64 `json:"rpm"`
	TPM   int64 `json:"tpm"`
}

func listLogs(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64, q logQuery) ([]logItem, int64, error) {
	tx, err := tenantx.BeginApp(ctx, begin, orgID)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback(ctx)
	where, args := logWhere(orgID, q)
	var total int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM ai_consume_logs WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limitArg := len(args) + 1
	offsetArg := len(args) + 2
	rows, err := tx.Query(ctx, `
		SELECT id, user_id, created_at, type, content, username, token_name, model_name,
		       quota, prompt_tokens, completion_tokens, use_time, is_stream, channel,
		       token_id, "group", ip, request_id, upstream_request_id, other
		  FROM ai_consume_logs WHERE `+where+`
		 ORDER BY created_at DESC, id DESC
		 LIMIT $`+strconv.Itoa(limitArg)+` OFFSET $`+strconv.Itoa(offsetArg),
		append(args, q.PageSize, (q.Page-1)*q.PageSize)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var items []logItem
	for rows.Next() {
		var item logItem
		var other []byte
		if err := rows.Scan(&item.ID, &item.UserID, &item.CreatedAt, &item.Type, &item.Content, &item.Username,
			&item.TokenName, &item.ModelName, &item.Quota, &item.PromptTokens, &item.Completion, &item.UseTime,
			&item.IsStream, &item.Channel, &item.TokenID, &item.Group, &item.IP, &item.RequestID, &item.UpstreamID, &other); err != nil {
			return nil, 0, err
		}
		if !q.Manager {
			item.Channel = 0
			item.IP = ""
		}
		item.Other = stripOther(other, q.Manager)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func statLogs(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64, q logQuery, now int64) (logStat, error) {
	tx, err := tenantx.BeginApp(ctx, begin, orgID)
	if err != nil {
		return logStat{}, err
	}
	defer tx.Rollback(ctx)
	where, args := logWhere(orgID, q)
	var stat logStat
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(quota), 0)::bigint FROM ai_consume_logs
		 WHERE `+where+` AND type = $`+strconv.Itoa(len(args)+1),
		append(args, logTypeConsume)...).Scan(&stat.Quota); err != nil {
		return logStat{}, err
	}
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::bigint,
		       COALESCE(SUM(prompt_tokens::bigint + completion_tokens::bigint), 0)::bigint
		  FROM ai_consume_logs
		 WHERE org_id = $1 AND type = $2 AND created_at >= $3`,
		orgID, logTypeConsume, now-60).Scan(&stat.RPM, &stat.TPM); err != nil {
		return logStat{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return logStat{}, err
	}
	return stat, nil
}

func logWhere(orgID int64, q logQuery) (string, []any) {
	parts := []string{"org_id = $1"}
	args := []any{orgID}
	add := func(cond string, val any) {
		args = append(args, val)
		parts = append(parts, fmt.Sprintf(cond, len(args)))
	}
	if q.Type != nil {
		add("type = $%d", *q.Type)
	}
	if q.Start != nil {
		add("created_at >= $%d", *q.Start)
	}
	if q.End != nil {
		add("created_at <= $%d", *q.End)
	}
	if q.Model != "" {
		add("model_name = $%d", q.Model)
	}
	if q.Token != "" {
		add("token_name = $%d", q.Token)
	}
	if q.Group != "" {
		add(`"group" = $%d`, q.Group)
	}
	if q.RequestID != "" {
		add("request_id = $%d", q.RequestID)
	}
	if q.UpstreamID != "" {
		add("upstream_request_id = $%d", q.UpstreamID)
	}
	if q.Manager && q.Username != "" {
		add("username = $%d", q.Username)
	}
	if q.Manager && q.Channel != nil {
		add("channel = $%d", *q.Channel)
	}
	return strings.Join(parts, " AND "), args
}

func parseLogQuery(r *http.Request, page bool) (logQuery, error) {
	q := logQuery{Page: 1, PageSize: logPageDefault}
	var err error
	if q.Type, err = optionalInt(r, "type"); err != nil || (q.Type != nil && (*q.Type < 0 || *q.Type > 7)) {
		return logQuery{}, errInvalid
	}
	if q.Start, err = optionalInt64(r, "start_timestamp"); err != nil {
		return logQuery{}, err
	}
	if q.End, err = optionalInt64(r, "end_timestamp"); err != nil {
		return logQuery{}, err
	}
	if q.Start != nil && q.End != nil && *q.Start > *q.End {
		return logQuery{}, errInvalid
	}
	q.Model = clip(r.URL.Query().Get("model_name"), 128)
	q.Token = clip(r.URL.Query().Get("token_name"), 128)
	q.Group = clip(r.URL.Query().Get("group"), 64)
	q.RequestID = clip(r.URL.Query().Get("request_id"), 64)
	q.UpstreamID = clip(r.URL.Query().Get("upstream_request_id"), 128)
	q.Username = clip(r.URL.Query().Get("username"), 128)
	if q.Channel, err = optionalInt(r, "channel"); err != nil {
		return logQuery{}, err
	}
	if !page {
		return q, nil
	}
	p, err := optionalInt(r, "p")
	if err != nil {
		return logQuery{}, err
	}
	if p != nil && *p > 0 {
		q.Page = *p
	}
	if q.Page > logPageLimit {
		return logQuery{}, errInvalid
	}
	size, err := optionalInt(r, "page_size")
	if err != nil {
		return logQuery{}, err
	}
	if size != nil && *size > 0 {
		q.PageSize = *size
	}
	if q.PageSize > logPageMax {
		q.PageSize = logPageMax
	}
	return q, nil
}

func optionalInt(r *http.Request, key string) (*int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return nil, errInvalid
	}
	return &n, nil
}

func optionalInt64(r *http.Request, key string) (*int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return nil, errInvalid
	}
	return &n, nil
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

func stripOther(raw []byte, manager bool) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	if manager {
		return append(json.RawMessage(nil), raw...)
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return json.RawMessage(`{}`)
	}
	for _, key := range []string{"admin_info", "root_info", "audit_info", "channel_id", "channel_name", "channel_type", "reject_reason"} {
		delete(obj, key)
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return out
}

// csvSafeRow prefixes formula triggers so a spreadsheet does not evaluate a cell.
func csvSafeRow(cells []string) []string {
	out := make([]string, len(cells))
	for i, cell := range cells {
		out[i] = csvSafe(cell)
	}
	return out
}

func csvSafe(cell string) string {
	if cell == "" {
		return cell
	}
	switch cell[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + cell
	default:
		return cell
	}
}

type clientIPKey struct{}

func withClientIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, clientIPKey{}, ip)
}

func clientIPFrom(ctx context.Context) string {
	ip, _ := ctx.Value(clientIPKey{}).(string)
	return ip
}

func logOther(settled newapibilling.Settlement, charged, absorbed int64, cache int) ([]byte, error) {
	payload := map[string]any{
		"model_ratio":           settled.ModelRatio,
		"group_ratio":           settled.GroupRatio,
		"completion_ratio":      settled.CompletionRatio,
		"cache_ratio":           settled.CacheRatio,
		"cache_tokens":          cache,
		"model_price":           settled.ModelPrice,
		"billing_source":        "wallet",
		"billing_preference":    "wallet_only",
		"wallet_quota_deducted": charged,
		"absorbed_microfen":     absorbed,
		"group":                 newapibilling.UsingGroup,
	}
	return json.Marshal(payload)
}
