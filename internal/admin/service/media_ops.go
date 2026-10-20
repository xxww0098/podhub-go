package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// ListObjects returns one directory page.
func (d Deps) ListObjects(ctx context.Context, accountID, path string, cursor *string) (ObjectPage, error) {
	account, signed, err := d.resolve(ctx, &accountID, false)
	if err != nil {
		return ObjectPage{}, err
	}
	rel, err := domain.RelativePath(path, true)
	if err != nil {
		return ObjectPage{}, fail(400, "VALIDATION", err.Error())
	}
	if err := domain.ParseMediaCursor(cursor); err != nil {
		return ObjectPage{}, fail(400, "VALIDATION", err.Error())
	}
	dir, err := domain.DirectoryPrefix(account.KeyPrefix, rel)
	if err != nil {
		return ObjectPage{}, fail(400, "VALIDATION", err.Error())
	}
	token := ""
	if cursor != nil {
		token = *cursor
	}
	page, err := d.listPage(ctx, signed, dir, "/", token, maxListKeys, true)
	if err != nil {
		return ObjectPage{}, err
	}
	items := directoryItems(account.KeyPrefix, dir, signed, page)
	out := ObjectPage{AccountID: account.ID, Prefix: rel, Items: items}
	if page.Truncated {
		out.HasCursor = true
		out.NextCursor = page.NextToken
	}
	return out, nil
}

func directoryItems(root, dir string, account sign.Account, page domain.ListPage) []ObjectItem {
	by := map[string]ObjectItem{}
	put := func(item ObjectItem) {
		if item.Path == "" || domain.IsReserved(root+item.Path) && item.Kind == "file" {
			return
		}
		by[item.Path] = item
	}
	for _, prefix := range page.Prefixes {
		if domain.IsReserved(prefix) {
			continue
		}
		path := strings.TrimPrefix(prefix, root)
		path = strings.TrimSuffix(path, "/")
		if path == "" || domain.IsReserved(prefix) {
			continue
		}
		put(ObjectItem{Path: path, Kind: "directory"})
	}
	for _, object := range page.Contents {
		if object.Key == dir || !strings.HasPrefix(object.Key, root) {
			continue
		}
		if domain.IsReserved(object.Key) {
			continue
		}
		path := strings.TrimPrefix(object.Key, root)
		kind := "file"
		if strings.HasSuffix(path, "/") {
			kind = "directory"
			path = strings.TrimSuffix(path, "/")
		}
		if path == "" {
			continue
		}
		item := ObjectItem{Path: path, Kind: kind, Bytes: object.Size}
		if object.LastModified != "" {
			item.LastModified = object.LastModified
			item.HasModified = true
		}
		if kind == "file" {
			item.PublicURL = sign.PublicURL(account, object.Key)
			item.HasPublic = true
		}
		put(item)
	}
	out := make([]ObjectItem, 0, len(by))
	for _, item := range by {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// CreateDirectory writes an empty application/x-directory object.
func (d Deps) CreateDirectory(ctx context.Context, accountID, path string) (string, string, error) {
	account, signed, err := d.resolve(ctx, &accountID, true)
	if err != nil {
		return "", "", err
	}
	rel, err := domain.RelativePath(path, false)
	if err != nil {
		return "", "", fail(400, "VALIDATION", err.Error())
	}
	dir, err := domain.DirectoryPrefix(account.KeyPrefix, rel)
	if err != nil {
		return "", "", fail(400, "VALIDATION", err.Error())
	}
	if err := d.refuse(ctx, account, []string{dir}); err != nil {
		return "", "", err
	}
	raw, err := presign(signed, methodPut, dir, "application/x-directory", d.now(), putDirTTL, nil, nil)
	if err != nil {
		return "", "", fail(500, "INTERNAL", "服务暂不可用")
	}
	status, _, _, err := d.exchange(ctx, methodPut, raw, map[string]string{"content-type": "application/x-directory"}, []byte{}, 0, true, true, 0)
	if err != nil {
		return "", "", fail(503, "UNAVAILABLE", "媒体源站暂不可用")
	}
	if status < 200 || status >= 300 {
		return "", "", fail(503, "UNAVAILABLE", "媒体源站拒绝写入（HTTP "+strconv.Itoa(status)+"）")
	}
	return account.ID, rel, nil
}

// MoveObject copies one file and deletes the source.
func (d Deps) MoveObject(ctx context.Context, accountID, sourcePath, destPath, kind string) error {
	if kind == "directory" {
		return fail(400, "VALIDATION", "不支持移动目录")
	}
	if kind != "file" {
		return fail(400, "VALIDATION", "请求格式无效")
	}
	account, signed, err := d.resolve(ctx, &accountID, true)
	if err != nil {
		return err
	}
	sourceRel, err := domain.RelativePath(sourcePath, false)
	if err != nil {
		return fail(400, "VALIDATION", err.Error())
	}
	destRel, err := domain.RelativePath(destPath, false)
	if err != nil {
		return fail(400, "VALIDATION", err.Error())
	}
	if sourceRel == destRel {
		return fail(400, "VALIDATION", "源路径与目标路径不能相同")
	}
	sourceKey, err := domain.ObjectKey(account.KeyPrefix, sourceRel)
	if err != nil {
		return fail(400, "VALIDATION", err.Error())
	}
	destKey, err := domain.ObjectKey(account.KeyPrefix, destRel)
	if err != nil {
		return fail(400, "VALIDATION", err.Error())
	}
	if err := d.refuse(ctx, account, []string{sourceKey, destKey}); err != nil {
		return err
	}
	copySource := "/" + sign.EncodePathSegment(strings.TrimSpace(signed.Bucket)) + "/" + sign.EncodeObjectPath(sourceKey)
	raw, err := presign(signed, methodPut, destKey, "", d.now(), copyTTL, nil, [][2]string{{"x-amz-copy-source", copySource}})
	if err != nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	status, _, body, err := d.exchange(ctx, methodPut, raw, map[string]string{"x-amz-copy-source": copySource}, []byte{}, copyTimeout, true, true, 0)
	if err != nil {
		return fail(503, "UNAVAILABLE", "源站 COPY 失败："+err.Error())
	}
	if status == statusNotFound {
		return fail(404, "VALIDATION", "源对象不存在")
	}
	if status < 200 || status >= 300 {
		return fail(503, "UNAVAILABLE", "源站 COPY HTTP "+strconv.Itoa(status))
	}
	if strings.Contains(string(body), "<Error>") || strings.Contains(string(body), "<Error ") {
		return fail(503, "UNAVAILABLE", "源站 COPY 返回内嵌错误")
	}
	kindDeleted, delErr := d.deleteKey(ctx, signed, sourceKey)
	if delErr != nil || kindDeleted == "failed" {
		msg := "源站 DELETE HTTP"
		if delErr != nil {
			msg = delErr.Error()
		}
		return fail(503, "UNAVAILABLE", msg)
	}
	d.markDeleted(ctx, account.ID, sourceKey)
	return nil
}

// DeleteResult is POST /api/admin/media/objects/delete.
type DeleteResult struct {
	AccountID string
	Path      string
	Kind      string
	Deleted   int64
	Missing   int64
	Failed    int64
	Remaining bool
}

// DeleteObjects removes a file or up to 500 keys under a directory.
func (d Deps) DeleteObjects(ctx context.Context, accountID, path, kind string) (DeleteResult, error) {
	if kind != "file" && kind != "directory" {
		return DeleteResult{}, fail(400, "VALIDATION", "请求格式无效")
	}
	account, signed, err := d.resolve(ctx, &accountID, false)
	if err != nil {
		return DeleteResult{}, err
	}
	rel, err := domain.RelativePath(path, false)
	if err != nil {
		return DeleteResult{}, fail(400, "VALIDATION", err.Error())
	}
	out := DeleteResult{AccountID: account.ID, Path: rel, Kind: kind}
	var keys []string
	more := false
	if kind == "file" {
		key, keyErr := domain.ObjectKey(account.KeyPrefix, rel)
		if keyErr != nil {
			return DeleteResult{}, fail(400, "VALIDATION", keyErr.Error())
		}
		keys = []string{key}
	} else {
		dir, dirErr := domain.DirectoryPrefix(account.KeyPrefix, rel)
		if dirErr != nil {
			return DeleteResult{}, fail(400, "VALIDATION", dirErr.Error())
		}
		page, listErr := d.listPage(ctx, signed, dir, "", "", maxTreeDelete+1, true)
		if listErr != nil {
			return DeleteResult{}, listErr
		}
		for _, object := range page.Contents {
			if domain.IsReserved(object.Key) {
				return DeleteResult{}, fail(400, "VALIDATION", domain.ErrReserved.Error())
			}
			keys = append(keys, object.Key)
		}
		more = page.Truncated || len(keys) > maxTreeDelete
		if len(keys) > maxTreeDelete {
			keys = keys[:maxTreeDelete]
		}
	}
	if err := d.refuse(ctx, account, keys); err != nil {
		return DeleteResult{}, err
	}
	for _, key := range keys {
		state, delErr := d.deleteKey(ctx, signed, key)
		switch {
		case delErr != nil || state == "failed":
			out.Failed++
		case state == "gone":
			out.Missing++
			d.markDeleted(ctx, account.ID, key)
		default:
			out.Deleted++
			d.markDeleted(ctx, account.ID, key)
		}
	}
	out.Remaining = more || out.Failed > 0
	return out, nil
}

// MediaUpload is the presign response.
type MediaUpload struct {
	AccountID   string
	Path        string
	URL         string
	ContentType string
	IfNoneMatch string
	Checksum    string
	ExpiresAtMS int64
	Ticket      string
}

// PresignUpload checks the destination and issues a stage ticket.
func (d Deps) PresignUpload(ctx context.Context, actor Actor, accountID, path, contentType, sha string, n int64, checksum bool) (MediaUpload, error) {
	if d.Tickets == nil {
		return MediaUpload{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	account, signed, err := d.resolve(ctx, &accountID, true)
	if err != nil {
		return MediaUpload{}, err
	}
	rel, err := domain.RelativePath(path, false)
	if err != nil {
		return MediaUpload{}, fail(400, "VALIDATION", err.Error())
	}
	if domain.HasDirectUploadSegment(rel) {
		return MediaUpload{}, fail(400, "VALIDATION", domain.ErrStageDir.Error())
	}
	key, err := domain.ObjectKey(account.KeyPrefix, rel)
	if err != nil {
		return MediaUpload{}, fail(400, "VALIDATION", err.Error())
	}
	if err := domain.ContentType(contentType); err != nil {
		return MediaUpload{}, fail(400, "VALIDATION", err.Error())
	}
	if n <= 0 || uint64(n) > sign.MaxObjectBytes {
		return MediaUpload{}, fail(400, "VALIDATION", "文件大小需在 1–2GiB 字节之间")
	}
	if err := d.refuse(ctx, account, []string{key}); err != nil {
		return MediaUpload{}, err
	}
	if err := d.requireAbsent(ctx, signed, key); err != nil {
		return MediaUpload{}, err
	}
	stageID, err := NewPublicID()
	if err != nil {
		return MediaUpload{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	stage := account.KeyPrefix + ".direct-uploads/" + stageID
	sum := sha256.Sum256([]byte(key))
	purpose := "admin-media-upload:" + hex.EncodeToString(sum[:])
	issued, err := d.Tickets.Issue(account, actor.UserID, purpose, stage, contentType, sha, uint64(n), checksum, d.now())
	if err != nil {
		return MediaUpload{}, err
	}
	return MediaUpload{
		AccountID: account.ID, Path: rel, URL: issued.URL, ContentType: issued.ContentType,
		IfNoneMatch: issued.IfNoneMatch, Checksum: issued.Checksum, ExpiresAtMS: issued.ExpiresAtMS, Ticket: issued.Ticket,
	}, nil
}

func (d Deps) requireAbsent(ctx context.Context, account sign.Account, key string) error {
	status, _, err := d.head(ctx, account, key, headTTL, listTimeout)
	if err != nil {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	switch {
	case status >= 200 && status < 300:
		return fail(409, "CONFLICT", "同名文件已存在，请更换名称；不会覆盖已有文件")
	case status == statusNotFound:
		return nil
	default:
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
}

func (d Deps) head(ctx context.Context, account sign.Account, key string, ttl, timeout time.Duration) (int, map[string][]string, error) {
	raw, err := presign(account, methodHead, key, "", d.now(), ttl, nil, nil)
	if err != nil {
		return 0, nil, err
	}
	status, header, _, err := d.exchange(ctx, methodHead, raw, nil, nil, timeout, true, true, 0)
	return status, header, err
}

func headerValue(header map[string][]string, name string) string {
	for key, values := range header {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}
