package corerepo

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const aadConfig = "platform_integration_config|v1"

// MissingRow is the supplier not-found sentence.
const MissingRow = "记录不存在或已删除"

// Begin opens a podhub_app transaction. The process passes tenantx.BeginApp.
type Begin func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// AESKey is the integration-config key.
func AESKey(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

// Seal encrypts an integration document.
func Seal(key, plain []byte) (nonce, ciphertext []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	ciphertext = gcm.Seal(nil, nonce, plain, []byte(aadConfig))
	return nonce, ciphertext, nil
}

// Open decrypts an integration document. A document sealed before the AAD
// was added still opens.
func Open(key, nonce, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, []byte(aadConfig))
	if err == nil {
		return plain, nil
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// WithRead is a staff read transaction.
func WithRead(ctx context.Context, pool *pgxpool.Pool, begin Begin, orgID int64, fn func(pgx.Tx) error) error {
	return Gate(ctx, pool, begin, orgID, true, false, fn)
}

// WithWrite is a supplier write transaction.
func WithWrite(ctx context.Context, pool *pgxpool.Pool, begin Begin, orgID int64, fn func(pgx.Tx) error) error {
	return Gate(ctx, pool, begin, orgID, false, true, fn)
}

// WithTx is a staff transaction that does not take the writer lease.
func WithTx(ctx context.Context, pool *pgxpool.Pool, begin Begin, orgID int64, fn func(pgx.Tx) error) error {
	if pool == nil || begin == nil {
		return Internal()
	}
	if orgID < 0 {
		orgID = 0
	}
	tx, err := begin(ctx, pool.Begin, orgID)
	if err != nil {
		return MapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	defer writer.Forget(tx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
		return MapDB(err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return MapDB(err)
	}
	return nil
}

// Gate opens the supplier transaction. staff sets app.staff_access. write
// takes the writer lease.
func Gate(ctx context.Context, pool *pgxpool.Pool, begin Begin, orgID int64, staff, write bool, fn func(pgx.Tx) error) error {
	if pool == nil || begin == nil {
		return Internal()
	}
	if orgID < 0 {
		orgID = 0
	}
	tx, err := begin(ctx, pool.Begin, orgID)
	if err != nil {
		return MapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	defer writer.Forget(tx)
	if err := tenantx.RequireOrg(ctx, tx); err != nil {
		return Internal()
	}
	if staff {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
			return MapDB(err)
		}
	}
	if write {
		if err := AssertWrite(ctx, tx); err != nil {
			return err
		}
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return MapDB(err)
	}
	return nil
}

// Identity is the caller's public id. owner is that id unless the role is super_admin.
func Identity(ctx context.Context, tx pgx.Tx, actor outcome.Actor) (publicID string, owner *string, err error) {
	err = tx.QueryRow(ctx, `SELECT public_id FROM public.account_users WHERE id = $1`, actor.UserID).Scan(&publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, Internal()
	}
	if err != nil {
		return "", nil, MapDB(err)
	}
	if actor.Role != "super_admin" {
		owner = &publicID
	}
	return publicID, owner, nil
}

// AssertWrite takes the supplier writer lease.
func AssertWrite(ctx context.Context, tx pgx.Tx) error {
	const disabled = "平台货源写入未启用"
	_, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), time.Now().UnixMilli(), disabled)
	if writer.IsDisabled(err) {
		return &outcome.Fail{Kind: outcome.KindWritesDisabled, Message: disabled}
	}
	return MapDB(err)
}

// AuditApplied inserts an audit row whose result is applied.
func AuditApplied(ctx context.Context, tx pgx.Tx, actor outcome.Actor, module, entityType, entityID, method, path, action, message string) error {
	org := actor.OrgID
	if org < 0 {
		org = 0
	}
	leaseID, fence := writer.AuditArgs(tx)
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (
		    org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		    action, status, result, message, shop_id, created_at_ms, created_at,
		    actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'applied', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $10, $11)`,
		org, actor.UserID, module, entityType, entityID, method, path, action, message, leaseID, fence)
	if err != nil {
		return Internal()
	}
	return nil
}

// Audit inserts an audit row whose result is success.
func Audit(ctx context.Context, tx pgx.Tx, actor outcome.Actor, module, entityType, entityID, method, path, action, message string) error {
	org := actor.OrgID
	if org < 0 {
		org = 0
	}
	leaseID, fence := writer.AuditArgs(tx)
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (
		    org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		    action, status, result, message, shop_id, created_at_ms, created_at,
		    actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
		        $8, 'success', 'success', $9, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $10, $11)`,
		org, actor.UserID, module, entityType, entityID, method, path, action, message, leaseID, fence)
	return MapDB(err)
}

// Internal is the supplier unavailable failure.
func Internal() *outcome.Fail {
	return &outcome.Fail{Kind: outcome.KindInternal, Message: "服务暂不可用"}
}

// NotFound is a supplier missing-row failure.
func NotFound(message string) *outcome.Fail {
	return &outcome.Fail{Kind: outcome.KindNotFound, Message: message}
}

// Conflict is a supplier conflict failure.
func Conflict(message string) *outcome.Fail {
	return &outcome.Fail{Kind: outcome.KindConflict, Message: message}
}

// Forbidden is a supplier forbidden failure.
func Forbidden(message string) *outcome.Fail {
	return &outcome.Fail{Kind: outcome.KindForbidden, Message: message}
}

// MapDB maps a database error onto a supplier failure.
func MapDB(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := outcome.AsFail(err); ok {
		return err
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "55P03":
			return &outcome.Fail{Kind: outcome.KindInternal, Status: 503, RetryAfter: 1, Message: "资源正在更新，请稍后重试"}
		case "P0M01":
			return &outcome.Fail{Kind: outcome.KindInternal, Status: 409, Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return Internal()
}

// Constraint is the unique-violation constraint name.
func Constraint(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return pe.ConstraintName
	}
	return ""
}

// IsFK reports a foreign-key violation.
func IsFK(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23503"
}

// ListDbs reads supplier sources. only restricts to one source id when set.
func ListDbs(ctx context.Context, tx pgx.Tx, owner *string, only string) ([]corecontract.SupplierDb, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.source_id, s.name, s.country, s.contact, s.internal_note, s.listed, s.icon,
		       s.accepts_delegate, s.view_prefs, s.created_at_ms, s.updated_at_ms,
		       s.created_by_account_uuid,
		       (SELECT profile.name FROM public.account_users creator
		          JOIN public.account_profiles profile ON profile.user_id = creator.id
		         WHERE creator.public_id = s.created_by_account_uuid) AS creator_name,
		       (SELECT COUNT(*) FROM public.sc_products p
		         WHERE p.source_id = s.source_id AND NOT p.archived
		           AND ($1::text IS NULL OR p.created_by_account_uuid = $1)) AS row_count,
		       (SELECT COUNT(*) FROM public.sc_products p
		         JOIN public.sc_skus k ON k.product_id = p.product_id
		         WHERE p.source_id = s.source_id AND NOT p.archived
		           AND p.published AND k.published
		           AND ($1::text IS NULL OR p.created_by_account_uuid = $1)) AS published_count,
		       (SELECT u.email FROM public.sc_source_members m
		          JOIN public.account_users u ON u.id = m.user_id
		         WHERE m.source_id = s.source_id
		         ORDER BY m.created_at_ms, m.member_id
		         LIMIT 1) AS account_email
		  FROM public.sc_sources s
		 WHERE ($1::text IS NULL OR s.created_by_account_uuid = $1)
		   AND ($2::text = '' OR s.source_id = $2)
		 ORDER BY s.created_at_ms, s.source_id`, owner, only)
	if err != nil {
		return nil, MapDB(err)
	}
	defer rows.Close()
	out := []corecontract.SupplierDb{}
	for rows.Next() {
		var db corecontract.SupplierDb
		var prefs []byte
		var creator, email *string
		if err := rows.Scan(&db.SourceID, &db.Name, &db.Country, &db.Contact, &db.InternalNote, &db.Listed, &db.Icon,
			&db.AcceptsDelegate, &prefs, &db.CreatedAtMs, &db.UpdatedAtMs, &db.CreatedBy,
			&creator, &db.RowCount, &db.PublishedCount, &email); err != nil {
			return nil, MapDB(err)
		}
		if len(prefs) == 0 {
			prefs = []byte(`{}`)
		}
		db.ViewPrefs = prefs
		db.CreatorName = creator
		db.AccountEmail = email
		out = append(out, db)
	}
	return out, MapDB(rows.Err())
}

// RequireSource fails when the source is missing or owned by someone else.
func RequireSource(ctx context.Context, tx pgx.Tx, sourceID string, owner *string) error {
	var id string
	err := tx.QueryRow(ctx, `
		SELECT source_id FROM public.sc_sources
		 WHERE source_id = $1 AND ($2::text IS NULL OR created_by_account_uuid = $2)`, sourceID, owner).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return NotFound(MissingRow)
	}
	return MapDB(err)
}

// LockSource locks the source row.
func LockSource(ctx context.Context, tx pgx.Tx, sourceID string) (int64, error) {
	var rev int64
	err := tx.QueryRow(ctx, `SELECT revision FROM public.sc_sources WHERE source_id = $1 FOR UPDATE`, sourceID).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, NotFound(MissingRow)
	}
	return rev, MapDB(err)
}

// LockProduct locks the product and its single SKU.
func LockProduct(ctx context.Context, tx pgx.Tx, sourceID, productID string) (sku string, published bool, err error) {
	err = tx.QueryRow(ctx, `
		SELECT product_id FROM public.sc_products
		 WHERE product_id = $1 AND source_id = $2 FOR UPDATE`, productID, sourceID).Scan(&productID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, NotFound(MissingRow)
	}
	if err != nil {
		return "", false, MapDB(err)
	}
	rows, err := tx.Query(ctx, `
		SELECT sku_id, published FROM public.sc_skus
		 WHERE product_id = $1 ORDER BY sku_id LIMIT 2 FOR UPDATE`, productID)
	if err != nil {
		return "", false, MapDB(err)
	}
	defer rows.Close()
	var skus []string
	for rows.Next() {
		var id string
		var pub bool
		if err := rows.Scan(&id, &pub); err != nil {
			return "", false, MapDB(err)
		}
		skus = append(skus, id)
	}
	if err := rows.Err(); err != nil {
		return "", false, MapDB(err)
	}
	if len(skus) != 1 {
		return "", false, Conflict("商品 SKU 数据不完整，请由管理员修复")
	}
	var productPublished bool
	if err := tx.QueryRow(ctx, `SELECT published FROM public.sc_products WHERE product_id = $1`, productID).Scan(&productPublished); err != nil {
		return "", false, MapDB(err)
	}
	return skus[0], productPublished, nil
}
