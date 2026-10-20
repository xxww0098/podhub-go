package adminrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

const (
	kindV1 = "desktop_error_log.v1"
	kindV2 = "desktop_error_log.v2"
	kindV3 = "desktop_error_log.v3"
	kindV4 = "desktop_error_log.v4"
	kindFB = "error_feedback.v1"
)

const errorFrom = `
 FROM event_inbox_events e
 JOIN organizations o ON o.id = e.org_id
 JOIN account_users u ON u.id = e.user_id
 WHERE e.kind IN ($1, $2, $3, $4, 'error_feedback.v1')
   AND ($5::text IS NULL OR o.name ILIKE '%' || $5 || '%'
        OR e.id ILIKE '%' || $5 || '%'
        OR u.email ILIKE '%' || $5 || '%'
        OR COALESCE(e.payload_json::jsonb->>'code', '') ILIKE '%' || $5 || '%'
        OR COALESCE(e.payload_json::jsonb->>'message', '') ILIKE '%' || $5 || '%'
        OR COALESCE(e.payload_json::jsonb->>'traceId', e.payload_json::jsonb#>>'{context,traceId}', '') ILIKE '%' || $5 || '%')
   AND ($6::text IS NULL OR COALESCE(e.payload_json::jsonb->>'source',
        CASE WHEN e.kind = 'desktop_error_log.v4' THEN 'workbench' WHEN e.kind = 'error_feedback.v1' THEN 'error_feedback' END) = $6)
   AND ($7::text IS NULL OR e.received_at >= $7::timestamptz)
   AND e.received_at >= $8::timestamptz
   AND ($9::text IS NULL OR COALESCE(e.payload_json::jsonb->>'platform', e.payload_json::jsonb#>>'{context,platform}') = $9)
   AND ($10::text IS NULL OR COALESCE(e.payload_json::jsonb->>'stage', e.payload_json::jsonb#>>'{context,stage}') = $10)
   AND ($11::text IS NULL OR e.payload_json::jsonb->>'code' = $11)`

func nullText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (r *Repo) ListErrors(ctx context.Context, actor domain.Actor, filter domain.ErrorFilter) ([]byte, error) {
	_ = actor
	query := filter.Query
	cutoff := r.now().Add(-30 * 24 * time.Hour)
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	if err := prescanErrors(ctx, tx, cutoff); err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	args := []any{kindV1, kindV2, kindV3, kindV4, nullText(query.Q), nullText(query.Source), nullText(query.Since), cutoff, nullText(query.Platform), nullText(query.Stage), nullText(query.Code)}
	var total int64
	if err := tx.QueryRow(ctx, `SELECT count(*)::bigint AS rows`+errorFrom, args...).Scan(&total); err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	pages, _ := domain.TotalPages(total, query.PageSize)
	page := domain.ClampPage(query.Page, pages)
	offset := int64(page-1) * int64(query.PageSize)
	if query.GroupBy == "platform_stage_code" {
		body, err := listErrorGroups(ctx, tx, args, total, pages, page, query.PageSize, offset)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
		}
		return body, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT e.id, e.device_uid, e.kind, e.schema_version, e.payload_json, e.received_at, o.name, u.email`+errorFrom+`
		 ORDER BY e.received_at DESC, e.device_uid, e.id
		 LIMIT $12 OFFSET $13`, append(args, query.PageSize, offset)...)
	if err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	defer rows.Close()
	out := []domain.ErrorRow{}
	for rows.Next() {
		var id, device, kind, payload, workspace, email string
		var schema int32
		var received time.Time
		if err := rows.Scan(&id, &device, &kind, &schema, &payload, &received, &workspace, &email); err != nil {
			return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
		}
		_ = schema
		row, fault := domain.ProjectErrorLog(kind, id, device, workspace, email, rfc3339Millis(received), payload)
		if fault != nil {
			return nil, fault
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	return data(struct {
		Page       int32             `json:"page"`
		PageSize   int32             `json:"page_size"`
		TotalPages int32             `json:"total_pages"`
		TotalRows  int64             `json:"total_rows"`
		Rows       []domain.ErrorRow `json:"rows"`
	}{page, query.PageSize, pages, total, out})
}

func prescanErrors(ctx context.Context, tx pgx.Tx, cutoff time.Time) error {
	rows, err := tx.Query(ctx, `
		SELECT e.device_uid, e.id, e.kind, e.schema_version,
		       CASE WHEN octet_length(e.payload_json) <= $4 THEN e.payload_json END
		  FROM event_inbox_events e
		  JOIN organizations o ON o.id = e.org_id
		  JOIN account_users u ON u.id = e.user_id
		 WHERE e.kind IN ($1, $2, 'error_feedback.v1') AND e.received_at >= $3
		 ORDER BY e.device_uid, e.id
		 LIMIT $5`, kindV3, kindV4, cutoff, 1048576, 64)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var device, id, kind string
		var schema int32
		var payload *string
		if err := rows.Scan(&device, &id, &kind, &schema, &payload); err != nil {
			return err
		}
		if payload == nil {
			return errors.New("payload")
		}
		if _, fault := domain.ProjectErrorLog(kind, id, device, "", "", "", *payload); fault != nil {
			return fault
		}
	}
	return rows.Err()
}

type errorGroup struct {
	Platform    *string `json:"platform"`
	Stage       *string `json:"stage"`
	Code        string  `json:"code"`
	EventCount  int64   `json:"event_count"`
	DeviceCount int64   `json:"device_count"`
}

func listErrorGroups(ctx context.Context, tx pgx.Tx, args []any, total int64, pages, page, pageSize int32, offset int64) ([]byte, error) {
	groupSQL := `SELECT COALESCE(e.payload_json::jsonb->>'platform', e.payload_json::jsonb#>>'{context,platform}') AS platform,
		COALESCE(e.payload_json::jsonb->>'stage', e.payload_json::jsonb#>>'{context,stage}') AS stage,
		COALESCE(e.payload_json::jsonb->>'code', '') AS code,
		count(*)::bigint AS event_count, count(DISTINCT e.device_uid)::bigint AS device_count` + errorFrom + `
		GROUP BY 1, 2, 3`
	var groupsTotal int64
	if err := tx.QueryRow(ctx, `SELECT count(*)::bigint AS n FROM (`+groupSQL+`) AS diagnostic_groups`, args...).Scan(&groupsTotal); err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	rows, err := tx.Query(ctx, groupSQL+` ORDER BY event_count DESC, platform NULLS LAST, stage NULLS LAST, code LIMIT $12 OFFSET $13`, append(args, pageSize, offset)...)
	if err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	defer rows.Close()
	groups := []errorGroup{}
	for rows.Next() {
		var item errorGroup
		if err := rows.Scan(&item.Platform, &item.Stage, &item.Code, &item.EventCount, &item.DeviceCount); err != nil {
			return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
		}
		groups = append(groups, item)
	}
	if err := rows.Err(); err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	return data(struct {
		Page        int32             `json:"page"`
		PageSize    int32             `json:"page_size"`
		TotalPages  int32             `json:"total_pages"`
		TotalRows   int64             `json:"total_rows"`
		Rows        []domain.ErrorRow `json:"rows"`
		Groups      []errorGroup      `json:"groups"`
		TotalGroups int64             `json:"total_groups"`
	}{page, pageSize, pages, total, []domain.ErrorRow{}, groups, groupsTotal})
}

func (r *Repo) DeleteErrors(ctx context.Context, actor domain.Actor, body domain.ErrorDelete) ([]byte, error) {
	tx, err := r.beginTx(ctx)
	if err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	defer tx.Rollback(ctx)
	defer endLease(tx)
	held, err := admit(ctx, tx, "telemetry", r.now().UnixMilli(), domain.WritesDisabled("WRITES_DISABLED", "遥测域写入未启用"))
	if err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	type key struct {
		EventID   string `json:"event_id"`
		DeviceUID string `json:"device_uid"`
	}
	keys := make([]key, 0, len(body.Events))
	for _, pair := range body.Events {
		keys = append(keys, key{EventID: pair[0], DeviceUID: pair[1]})
	}
	payload, _ := json.Marshal(keys)
	tag, err := tx.Exec(ctx, `
		DELETE FROM event_inbox_events e
		 USING jsonb_to_recordset($5::jsonb) AS selected(event_id text, device_uid text)
		 WHERE e.kind IN ($1, $2, $3, $4, $6)
		   AND e.id = selected.event_id AND e.device_uid = selected.device_uid`,
		kindV1, kindV2, kindV3, kindV4, string(payload), kindFB)
	if err != nil {
		return nil, domain.Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	deleted := tag.RowsAffected()
	message, _ := json.Marshal(struct {
		Requested int   `json:"requested_count"`
		Deleted   int64 `json:"deleted_count"`
	}{len(body.Events), deleted})
	if err := auditBill(ctx, tx, orgAtLeast0(actor.OrgID), actor.UserID, "telemetry", "desktop_error_log", "batch", "DELETE",
		"/api/admin/error-logs", "desktop_error_logs_deleted", string(message), held); err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapBill(err, "INTERNAL", true)
	}
	return data(struct {
		DeletedCount int64 `json:"deleted_count"`
	}{deleted})
}
