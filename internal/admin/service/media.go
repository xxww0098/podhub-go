package service

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const (
	maxListPages    = 200
	maxListKeys     = 1000
	maxStoredKeys   = 200000
	maxPurgeObjects = 500
	maxTreeDelete   = 500
	listTimeout     = 30 * time.Second
	presignList     = 60 * time.Second
	headTTL         = 600 * time.Second
	putDirTTL       = 300 * time.Second
	copyTTL         = 60 * time.Second
	copyTimeout     = 60 * time.Second
	deleteTimeout   = 30 * time.Second
	verifyGetTTL    = 300 * time.Second
	confirmTimeout  = 3900 * time.Second
	methodGet       = "GET"
	methodPut       = "PUT"
	methodHead      = "HEAD"
	methodDelete    = "DELETE"
	statusNotFound  = 404
	statusPrecond   = 412
)

// StorageView is GET /api/admin/media/storage.
type StorageView struct {
	AccountID string
	Bucket    string
	Prefix    string
	Objects   int64
	Bytes     int64
	Truncated bool
	ScannedAt int64
	Groups    []domain.Group
}

// PurgeView is POST /api/admin/media/purge.
type PurgeView struct {
	AccountID string
	Prefix    string
	Deleted   int64
	Missing   int64
	Failed    int64
	Bytes     int64
	Remaining bool
}

// ObjectItem is one directory listing row.
type ObjectItem struct {
	Path         string
	Kind         string
	Bytes        int64
	LastModified string
	PublicURL    string
	HasModified  bool
	HasPublic    bool
}

// ObjectPage is GET /api/admin/media/objects.
type ObjectPage struct {
	AccountID  string
	Prefix     string
	Items      []ObjectItem
	NextCursor string
	HasCursor  bool
}

func (d Deps) loadAccounts(ctx context.Context) ([]domain.CloudAccount, error) {
	if d.Pool == nil {
		return nil, fail(500, "INTERNAL", "服务暂不可用")
	}
	var nonce, ciphertext []byte
	err := d.Pool.QueryRow(ctx, `SELECT nonce, ciphertext FROM public.platform_integration_config WHERE singleton = true`).Scan(&nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail(503, "UNAVAILABLE", "平台尚未配置媒体存储")
	}
	if err != nil {
		return nil, mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	if len(nonce) != 12 {
		slog.Error("连接配置密文 nonce 长度无效")
		return nil, fail(500, "INTERNAL", "服务暂不可用")
	}
	accounts, err := domain.OpenSnapshot(d.Key, nonce, ciphertext)
	if err == nil {
		return accounts, nil
	}
	switch {
	case errors.Is(err, domain.ErrKeyMissing), errors.Is(err, domain.ErrKeyExample):
		return nil, fail(503, "UNAVAILABLE", err.Error())
	case errors.Is(err, domain.ErrSchema):
		slog.Error("已存储的连接配置 schema 版本不受支持")
		return nil, fail(500, "INTERNAL", "服务暂不可用")
	default:
		slog.Error("连接配置快照解密失败", "err", err)
		return nil, fail(500, "INTERNAL", "服务暂不可用")
	}
}

func (d Deps) resolve(ctx context.Context, id *string, persistent bool) (domain.CloudAccount, sign.Account, error) {
	accounts, err := d.loadAccounts(ctx)
	if err != nil {
		return domain.CloudAccount{}, sign.Account{}, err
	}
	account, err := domain.ResolveAccount(accounts, id)
	if errors.Is(err, domain.ErrAccount) {
		return domain.CloudAccount{}, sign.Account{}, fail(400, "VALIDATION", err.Error())
	}
	if errors.Is(err, domain.ErrNoConfig) {
		return domain.CloudAccount{}, sign.Account{}, fail(503, "UNAVAILABLE", err.Error())
	}
	if err != nil {
		return domain.CloudAccount{}, sign.Account{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	prefix, err := domain.NormalizeKeyPrefix(account.KeyPrefix)
	if err != nil {
		return domain.CloudAccount{}, sign.Account{}, fail(400, "VALIDATION", err.Error())
	}
	account.KeyPrefix = prefix
	if persistent {
		if err := domain.RequirePersistent(account); err != nil {
			return domain.CloudAccount{}, sign.Account{}, fail(409, "CONFLICT", err.Error())
		}
	}
	return account, toSign(account), nil
}

func toSign(account domain.CloudAccount) sign.Account {
	return sign.Account{
		ID: account.ID, Provider: sign.Provider(account.Provider), Endpoint: account.Endpoint,
		Region: account.Region, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix,
		PublicBaseURL: account.PublicBaseURL, ForcePathStyle: account.ForcePathStyle,
		AccessKeyID: account.AccessKeyID, SecretAccessKey: account.SecretAccessKey,
		SessionToken: account.SessionToken,
	}
}

func (d Deps) exchange(ctx context.Context, method, rawURL string, headers map[string]string, body []byte, timeout time.Duration, noCompress, strict bool, max int64) (int, map[string][]string, []byte, error) {
	if d.Origin == nil {
		return 0, nil, nil, fail(500, "INTERNAL", "服务暂不可用")
	}
	return d.Origin.Exchange(ctx, method, rawURL, headers, body, timeout, noCompress, strict, max)
}

func presign(account sign.Account, method, key, contentType string, now time.Time, exp time.Duration, query, headers [][2]string) (string, error) {
	raw, _, err := sign.PresignURL(account, method, key, contentType, now, exp, query, headers)
	if err != nil {
		slog.Error("presign", "err", err)
		return "", err
	}
	return raw, nil
}

func listQuery(prefix, delimiter, token string, maxKeys int) [][2]string {
	query := [][2]string{{"list-type", "2"}, {"max-keys", strconv.Itoa(maxKeys)}}
	if prefix != "" {
		query = append(query, [2]string{"prefix", prefix})
	}
	if delimiter != "" {
		query = append(query, [2]string{"delimiter", delimiter})
	}
	if token != "" {
		query = append(query, [2]string{"continuation-token", token})
	}
	return query
}

func (d Deps) listPage(ctx context.Context, account sign.Account, prefix, delimiter, token string, maxKeys int, strict bool) (domain.ListPage, error) {
	raw, err := presign(account, methodGet, "", "", d.now(), presignList, listQuery(prefix, delimiter, token, maxKeys), nil)
	if err != nil {
		return domain.ListPage{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	status, _, body, err := d.exchange(ctx, methodGet, raw, nil, nil, listTimeout, strict, strict, 0)
	if err != nil {
		if strict {
			return domain.ListPage{}, fail(503, "UNAVAILABLE", "源站列举失败："+err.Error())
		}
		return domain.ListPage{}, fail(503, "UNAVAILABLE", "源站列举失败："+err.Error())
	}
	if status < 200 || status >= 300 {
		return domain.ListPage{}, fail(503, "UNAVAILABLE", "源站列举 HTTP "+strconv.Itoa(status))
	}
	return domain.ParseListPage(string(body)), nil
}

func (d Deps) scan(ctx context.Context, account sign.Account, prefix string, pages int) ([]domain.ListedObject, bool, error) {
	var objects []domain.ListedObject
	token := ""
	truncated := false
	for page := 0; page < pages; page++ {
		listed, err := d.listPage(ctx, account, prefix, "", token, maxListKeys, false)
		if err != nil {
			return nil, false, err
		}
		objects = append(objects, listed.Contents...)
		if len(objects) > maxStoredKeys {
			objects = objects[:maxStoredKeys]
			return objects, true, nil
		}
		if !listed.Truncated || listed.NextToken == "" {
			return objects, false, nil
		}
		token = listed.NextToken
		if page+1 == pages {
			truncated = true
		}
	}
	return objects, truncated, nil
}

// Storage scans a prefix and writes the read audit.
func (d Deps) Storage(ctx context.Context, actor Actor, accountID *string, requested string) (StorageView, error) {
	account, signed, err := d.resolve(ctx, accountID, false)
	if err != nil {
		return StorageView{}, err
	}
	prefix, err := domain.NormalizeListPrefix(account.KeyPrefix, requested)
	if err != nil {
		return StorageView{}, fail(400, "VALIDATION", err.Error())
	}
	objects, scanTrunc, err := d.scan(ctx, signed, prefix, maxListPages)
	if err != nil {
		return StorageView{}, err
	}
	groups, n, bytes, groupTrunc := domain.GroupRows(account.KeyPrefix, objects)
	d.attachNames(ctx, groups)
	view := StorageView{
		AccountID: account.ID, Bucket: account.Bucket, Prefix: prefix,
		Objects: n, Bytes: bytes, Truncated: scanTrunc || groupTrunc,
		ScannedAt: d.nowMS(), Groups: groups,
	}
	if err := d.audit(ctx, actor.OrgID, actor.UserID, "media_upload", "media_storage", account.ID, "GET", "/api/admin/media/storage", "media_storage_scanned", map[string]any{
		"summary": "统计对象存储用量", "account_id": account.ID, "prefix": prefix, "objects": n, "bytes": bytes,
	}); err != nil {
		return StorageView{}, err
	}
	return view, nil
}

func (d Deps) attachNames(ctx context.Context, groups []domain.Group) {
	var ids []string
	seen := map[string]struct{}{}
	for _, group := range groups {
		if group.UUID == "" {
			continue
		}
		if _, ok := seen[group.UUID]; ok {
			continue
		}
		seen[group.UUID] = struct{}{}
		ids = append(ids, group.UUID)
	}
	if len(ids) == 0 || d.Pool == nil {
		return
	}
	rows, err := d.Pool.Query(ctx, `SELECT lower(uuid::text) AS uuid, name FROM organizations WHERE uuid = ANY($1::text[]::uuid[])`, ids)
	if err != nil {
		slog.Warn("media workspace names", "err", err)
		return
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			slog.Warn("media workspace names", "err", err)
			return
		}
		names[id] = name
	}
	if err := rows.Err(); err != nil {
		slog.Warn("media workspace names", "err", err)
		return
	}
	for i := range groups {
		if groups[i].WorkspaceName == "" {
			groups[i].WorkspaceName = names[groups[i].UUID]
		}
	}
}

// Purge deletes up to 500 keys under a prefix.
func (d Deps) Purge(ctx context.Context, actor Actor, accountID, requested string) (PurgeView, error) {
	id := accountID
	account, signed, err := d.resolve(ctx, &id, false)
	if err != nil {
		return PurgeView{}, err
	}
	prefix, err := domain.NormalizeListPrefix(account.KeyPrefix, requested)
	if err != nil {
		return PurgeView{}, fail(400, "VALIDATION", err.Error())
	}
	if strings.TrimSpace(prefix) == "" {
		return PurgeView{}, fail(400, "VALIDATION", "删除必须指定对象前缀")
	}
	objects, truncated, err := d.scan(ctx, signed, prefix, 1)
	if err != nil {
		return PurgeView{}, err
	}
	for _, object := range objects {
		if domain.IsReserved(object.Key) {
			return PurgeView{}, fail(400, "VALIDATION", domain.ErrReserved.Error())
		}
	}
	remaining := truncated || len(objects) > maxPurgeObjects
	if len(objects) > maxPurgeObjects {
		objects = objects[:maxPurgeObjects]
	}
	view := PurgeView{AccountID: account.ID, Prefix: prefix, Remaining: remaining}
	for _, object := range objects {
		kind, delErr := d.deleteKey(ctx, signed, object.Key)
		switch {
		case delErr != nil || kind == "failed":
			view.Failed++
		case kind == "gone":
			view.Missing++
			d.markDeleted(ctx, account.ID, object.Key)
		default:
			view.Deleted++
			view.Bytes += object.Size
			d.markDeleted(ctx, account.ID, object.Key)
		}
	}
	if err := d.audit(ctx, actor.OrgID, actor.UserID, "media_upload", "media_storage", account.ID, "POST", "/api/admin/media/purge", "media_storage_purged", map[string]any{
		"summary": "删除对象存储数据", "account_id": account.ID, "prefix": prefix,
		"deleted": view.Deleted, "missing": view.Missing, "failed": view.Failed, "bytes": view.Bytes,
	}); err != nil {
		return PurgeView{}, err
	}
	return view, nil
}

func (d Deps) deleteKey(ctx context.Context, account sign.Account, key string) (string, error) {
	raw, err := presign(account, methodDelete, key, "", d.now(), presignList, nil, nil)
	if err != nil {
		slog.Warn("无法签发源站 DELETE", "err", err)
		return "failed", errors.New("无法签发源站 DELETE")
	}
	status, _, _, err := d.exchange(ctx, methodDelete, raw, nil, nil, deleteTimeout, true, true, 0)
	if err != nil {
		slog.Warn("源站 DELETE", "err", err)
		return "failed", err
	}
	switch {
	case status >= 200 && status < 300:
		return "deleted", nil
	case status == statusNotFound:
		return "gone", nil
	default:
		msg := "源站 DELETE HTTP " + strconv.Itoa(status)
		slog.Warn(msg)
		return "failed", errors.New(msg)
	}
}

func (d Deps) markDeleted(ctx context.Context, accountID, key string) {
	if d.Pool == nil {
		return
	}
	_, err := d.Pool.Exec(ctx, `UPDATE media_object_leases
   SET deleted_at = clock_timestamp(), public_ready_at = NULL,
       public_url = CASE WHEN public.is_media_gc_image_key(object_key) THEN public_url END,
       updated_at = clock_timestamp()
 WHERE media_account_id = $1 AND object_key = $2 AND deleted_at IS NULL`, accountID, key)
	if err != nil {
		slog.Warn("mark media lease deleted", "err", err)
	}
}

func (d Deps) refuse(ctx context.Context, account domain.CloudAccount, keys []string) error {
	if len(keys) == 0 || d.Pool == nil {
		if d.Pool == nil && len(keys) > 0 {
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		return nil
	}
	for _, key := range keys {
		if domain.IsReserved(key) {
			return fail(400, "VALIDATION", domain.ErrReserved.Error())
		}
	}
	seen := map[string]struct{}{}
	var list []string
	add := func(key string) {
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		list = append(list, key)
	}
	for _, key := range keys {
		add(key)
		if strings.HasPrefix(key, account.KeyPrefix) {
			add(strings.TrimPrefix(key, account.KeyPrefix))
		}
	}
	var managed bool
	err := d.Pool.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM media_object_leases
     WHERE media_account_id = $1 AND object_key = ANY($2::text[]) AND deleted_at IS NULL
    UNION ALL
    SELECT 1 FROM media_blobs
     WHERE storage_key = ANY($2::text[]) AND state <> 'deleted'
    UNION ALL
    SELECT 1 FROM media_uploads
     WHERE storage_key = ANY($2::text[]) AND state IN ('pending', 'finalized')
) AS managed`, account.ID, list).Scan(&managed)
	if errors.Is(err, pgx.ErrNoRows) {
		slog.Error("媒体对象引用检查未返回结果")
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	if err != nil {
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	if managed {
		return fail(409, "CONFLICT", "对象仍被媒体租约、媒体库或上传会话管理，不能覆盖、移动或删除")
	}
	return nil
}
