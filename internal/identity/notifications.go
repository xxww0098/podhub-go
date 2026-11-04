package identity

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

const notificationPageSize = 50

type notificationCursor struct {
	Created time.Time `json:"created"`
	ID      int64     `json:"id"`
}

// Project only public snapshot fields for the signed-in account.
const notificationProjection = `
SELECT n.id, n.created_at,
 jsonb_build_object('uuid', n.uuid::text,
  'kind', CASE WHEN n.kind = 'team_invitation' THEN 'workspace_invitation' ELSE n.kind END,
  'created_at_ms', (extract(epoch FROM n.created_at) * 1000)::bigint,
  'read_at_ms', (extract(epoch FROM n.read_at) * 1000)::bigint)
 || CASE n.kind
 WHEN 'team_invitation' THEN jsonb_build_object('invitation',
  CASE WHEN i.id IS NULL THEN NULL ELSE jsonb_build_object(
   'uuid', i.uuid::text, 'workspace_id', i.org_id,
   'workspace_name', COALESCE(n.payload->>'teamName', o.name),
   'role', COALESCE(n.payload->>'role', i.role),
   'inviter_email', COALESCE(n.payload->>'invitedByEmail', i.invited_by_email),
   'expires_at_ms', (extract(epoch FROM i.expires_at) * 1000)::bigint,
   'status', CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted'
    WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.declined_at IS NOT NULL THEN 'declined'
    WHEN i.expires_at <= clock_timestamp() THEN 'expired' ELSE 'pending' END) END)
 WHEN 'agent_commission_credited' THEN jsonb_build_object('commission', jsonb_build_object(
  'amount_cents', n.payload->'amountCents', 'payment_order_public_id', n.payload->>'paymentOrderPublicId',
  'invitee_email', CASE WHEN position('@' IN COALESCE(n.payload->>'inviteeEmail', '')) > 0
   THEN left(n.payload->>'inviteeEmail', 1) || '***@' || split_part(n.payload->>'inviteeEmail', '@', 2)
   ELSE '***' END))
 WHEN 'agent_withdrawal_paid' THEN jsonb_build_object('withdrawal', jsonb_build_object(
  'amount_cents', n.payload->'amountCents', 'public_id', n.payload->>'publicId'))
 WHEN 'agent_withdrawal_rejected' THEN jsonb_build_object('withdrawal', jsonb_build_object(
  'amount_cents', n.payload->'amountCents', 'public_id', n.payload->>'publicId', 'reject_reason', n.payload->'rejectReason'))
 WHEN 'subscription_renewal_due' THEN jsonb_build_object('subscription', jsonb_build_object(
  'public_id', n.payload->>'publicId', 'amount_cents', n.payload->'amountCents', 'term_end_ms', n.payload->'termEndMs'))
 WHEN 'subscription_frozen' THEN jsonb_build_object('subscription', jsonb_build_object(
  'workspace_name', n.payload->>'workspaceName'))
 WHEN 'delegate_order_event' THEN jsonb_build_object('delegate_event', jsonb_build_object(
  'event', n.payload->>'event', 'order_id', n.payload->>'orderId', 'posting_number', n.payload->>'postingNumber',
  'source_name', n.payload->>'sourceName', 'tracking_no', n.payload->'trackingNo', 'reject_reason', n.payload->'rejectReason'))
 ELSE '{}'::jsonb END
FROM notifications n
LEFT JOIN org_invitations i ON i.id = n.invitation_id
LEFT JOIN organizations o ON o.id = i.org_id
WHERE n.user_id = $1 AND n.dismissed_at IS NULL
 AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2, $3))
ORDER BY n.created_at DESC, n.id DESC LIMIT 51`

func (s *Service) Notifications(r *http.Request) Result {
	_, _, acc, refusal, ok := s.requireAccount(r)
	if !ok {
		return refusal
	}
	var cursor notificationCursor
	var created *time.Time
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		if len(raw) > 256 || err != nil || json.Unmarshal(decoded, &cursor) != nil || cursor.ID <= 0 || cursor.Created.IsZero() {
			return authResult(http.StatusBadRequest, "无效的通知分页游标", "VALIDATION")
		}
		created = &cursor.Created
	}
	tx, err := s.pool.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return dbResult(err)
	}
	defer tx.Rollback(r.Context())
	if err := tenantx.EnterStaff(r.Context(), tx); err != nil {
		return dbResult(err)
	}
	var total, unread int64
	if err := tx.QueryRow(r.Context(), `SELECT count(*), count(*) FILTER (WHERE read_at IS NULL) FROM notifications WHERE user_id = $1 AND dismissed_at IS NULL`, acc.id).Scan(&total, &unread); err != nil {
		return dbResult(err)
	}
	rows, err := tx.Query(r.Context(), notificationProjection, acc.id, created, cursor.ID)
	if err != nil {
		return dbResult(err)
	}
	notifications := make([]json.RawMessage, 0, notificationPageSize)
	var next *string
	var last notificationCursor
	for rows.Next() {
		var current notificationCursor
		var item json.RawMessage
		if err := rows.Scan(&current.ID, &current.Created, &item); err != nil {
			rows.Close()
			return dbResult(err)
		}
		if len(notifications) == notificationPageSize {
			raw, _ := json.Marshal(last)
			value := base64.RawURLEncoding.EncodeToString(raw)
			next = &value
			break
		}
		notifications = append(notifications, item)
		last = current
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return dbResult(err)
	}
	if err := tx.Commit(r.Context()); err != nil {
		return dbResult(err)
	}
	body, err := json.Marshal(map[string]any{"data": map[string]any{"notifications": notifications, "total": total, "unread": unread, "next_cursor": next}})
	if err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: body}
}

func (s *Service) MarkNotificationsRead(r *http.Request, id string) Result {
	_, _, acc, refusal, ok := s.requireAccount(r)
	if !ok {
		return refusal
	}
	if id != "" {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return authResult(http.StatusBadRequest, "无效的通知", "VALIDATION")
		}
		id = parsed.String()
	}
	var unread int64
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return dbResult(err)
	}
	defer tx.Rollback(r.Context())
	if err := tenantx.EnterStaff(r.Context(), tx); err != nil {
		return dbResult(err)
	}
	q := sqlc.New(tx)
	if _, err := q.LockAccount(r.Context(), acc.id); err != nil {
		return dbResult(err)
	}
	tag, err := tx.Exec(r.Context(), `UPDATE notifications SET read_at = COALESCE(read_at, clock_timestamp()) WHERE user_id = $1 AND dismissed_at IS NULL AND ($2 = '' OR uuid::text = $2)`, acc.id, id)
	if err == nil && id != "" && tag.RowsAffected() == 0 {
		err = pgx.ErrNoRows
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return authResult(http.StatusNotFound, "通知不存在", "NOT_FOUND")
	}
	if err != nil {
		return dbResult(err)
	}
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL`, acc.id).Scan(&unread); err != nil {
		return dbResult(err)
	}
	if err := q.InsertAudit(r.Context(), sqlc.InsertAuditParams{OrgID: acc.orgID, UserID: acc.id, Module: "notifications", EntityType: "notification", EntityID: id, ApiMethod: "POST", ApiPath: r.URL.Path, Action: "notifications_read", Message: `{"summary":"标记通知已读"}`}); err != nil {
		return dbResult(err)
	}
	if err := tx.Commit(r.Context()); err != nil {
		return dbResult(err)
	}
	return Result{Status: http.StatusOK, Body: []byte(`{"data":{"ok":true,"unread":` + strconv.FormatInt(unread, 10) + `}}`)}
}
