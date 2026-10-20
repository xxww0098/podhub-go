package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// Confirmed is a finished admin upload.
type Confirmed struct {
	AccountID string
	Path      string
	PublicURL string
}

// Confirm promotes a staged upload, or replays a promotion that already matches.
// recheck is the second super-admin admission after the object is read.
// Checksum HEAD query names are unspecified, so a checksum ticket still uses
// the full-body GET that the spec uses when the store did not prove the object.
func (d Deps) Confirm(ctx context.Context, actor Actor, accountID, path, ticket string, recheck func(context.Context) error) (Confirmed, error) {
	if d.Tickets == nil {
		return Confirmed{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	account, signed, err := d.resolve(ctx, &accountID, true)
	if err != nil {
		return Confirmed{}, err
	}
	rel, destination, err := uploadKey(account, path)
	if err != nil {
		return Confirmed{}, err
	}
	sum := sha256.Sum256([]byte(destination))
	purpose := "admin-media-upload:" + hex.EncodeToString(sum[:])
	verified, err := d.Tickets.Verify(account, actor.UserID, purpose, ticket, d.now())
	if err != nil {
		return Confirmed{}, err
	}
	stageRoot := account.KeyPrefix + ".direct-uploads/"
	if !strings.HasPrefix(verified.Key, stageRoot) {
		return Confirmed{}, fail(400, "VALIDATION", "上传暂存键无效")
	}
	marker, err := d.Tickets.Marker(account, verified.StorageIdentity, verified.Key, destination, verified.SHA256, verified.ContentType, verified.ByteLength)
	if err != nil {
		return Confirmed{}, err
	}
	replay, err := d.confirmed(ctx, signed, destination, marker, verified)
	if err == errExists {
		replay, err = false, nil
	}
	if err != nil {
		return Confirmed{}, err
	}
	if replay {
		if err := d.verifyObject(ctx, signed, destination, verified); err != nil {
			return Confirmed{}, err
		}
	} else {
		if err := d.refuse(ctx, account, []string{destination}); err != nil {
			return Confirmed{}, err
		}
		if err := d.verifyObject(ctx, signed, verified.Key, verified); err != nil {
			return Confirmed{}, err
		}
	}
	if recheck != nil {
		if err := recheck(ctx); err != nil {
			return Confirmed{}, err
		}
	}
	account, signed, err = d.resolve(ctx, &accountID, true)
	if err != nil {
		return Confirmed{}, err
	}
	if d.Tickets.Identity(account) != verified.StorageIdentity {
		return Confirmed{}, fail(409, "CONFLICT", "存储配置已变更，请重新选择文件")
	}
	if _, err := d.Tickets.Verify(account, actor.UserID, purpose, ticket, d.now()); err != nil {
		return Confirmed{}, err
	}
	if !replay {
		if err := d.refuse(ctx, account, []string{destination}); err != nil {
			return Confirmed{}, err
		}
		if err := d.promote(ctx, signed, verified.Key, destination, marker, verified); err != nil {
			return Confirmed{}, err
		}
	}
	return Confirmed{AccountID: account.ID, Path: rel, PublicURL: sign.PublicURL(signed, destination)}, nil
}

func uploadKey(account domain.CloudAccount, path string) (string, string, error) {
	rel, err := domain.RelativePath(path, false)
	if err != nil {
		return "", "", fail(400, "VALIDATION", err.Error())
	}
	if domain.HasDirectUploadSegment(rel) {
		return "", "", fail(400, "VALIDATION", domain.ErrStageDir.Error())
	}
	key, err := domain.ObjectKey(account.KeyPrefix, rel)
	if err != nil {
		return "", "", fail(400, "VALIDATION", err.Error())
	}
	return rel, key, nil
}

func (d Deps) confirmed(ctx context.Context, account sign.Account, key, marker string, verified Verified) (bool, error) {
	status, header, err := d.head(ctx, account, key, headTTL, listTimeout)
	if err != nil {
		return false, fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	if status == statusNotFound {
		return false, nil
	}
	if status < 200 || status >= 300 {
		return false, fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	length := headerValue(header, "content-length")
	n, parseErr := strconv.ParseUint(strings.TrimSpace(length), 10, 64)
	matched := headerValue(header, "x-amz-meta-podhub-upload") == marker && parseErr == nil && n == verified.ByteLength && headerValue(header, "content-type") == verified.ContentType
	if !matched {
		return false, errExists
	}
	return true, nil
}

var errExists = fail(409, "CONFLICT", "同名文件已存在，请更换名称；不会覆盖已有文件")

func (d Deps) verifyObject(ctx context.Context, account sign.Account, key string, verified Verified) error {
	raw, err := presign(account, methodGet, key, "", d.now(), verifyGetTTL, nil, nil)
	if err != nil {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	status, header, body, err := d.exchange(ctx, methodGet, raw, nil, nil, confirmTimeout, true, true, int64(verified.ByteLength))
	if err != nil && strings.Contains(err.Error(), "exceeds limit") {
		return fail(409, "CONFLICT", "上传对象超过授权长度")
	}
	if err != nil {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	if status == statusNotFound {
		return fail(404, "MEDIA_COMPLETE_MISSING", "上传对象尚不存在")
	}
	if status < 200 || status >= 300 {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	if length := strings.TrimSpace(headerValue(header, "content-length")); length != "" {
		n, parseErr := strconv.ParseUint(length, 10, 64)
		if parseErr != nil || n != verified.ByteLength {
			return fail(409, "CONFLICT", "上传对象长度与授权不一致")
		}
	}
	gotType := headerValue(header, "content-type")
	if i := strings.IndexByte(gotType, ';'); i >= 0 {
		gotType = gotType[:i]
	}
	if strings.TrimSpace(gotType) != verified.ContentType {
		return fail(409, "CONFLICT", "上传对象文件类型与授权不一致")
	}
	sum := sha256.Sum256(body)
	if uint64(len(body)) != verified.ByteLength || hex.EncodeToString(sum[:]) != verified.SHA256 {
		return fail(409, "CONFLICT", "上传对象校验不一致，请勿覆盖该对象")
	}
	return nil
}

func (d Deps) promote(ctx context.Context, account sign.Account, stage, destination, marker string, verified Verified) error {
	matched, err := d.confirmed(ctx, account, destination, marker, verified)
	if err == errExists {
		return err
	}
	if err != nil {
		return err
	}
	if matched {
		return nil
	}
	raw, err := presign(account, methodGet, stage, "", d.now(), headTTL, nil, nil)
	if err != nil {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	getStatus, _, body, err := d.exchange(ctx, methodGet, raw, nil, nil, confirmTimeout, true, true, int64(verified.ByteLength))
	if err != nil || getStatus < 200 || getStatus >= 300 {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	sum := sha256.Sum256(body)
	if uint64(len(body)) != verified.ByteLength || hex.EncodeToString(sum[:]) != verified.SHA256 {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	headers := [][2]string{
		{"content-length", strconv.FormatUint(verified.ByteLength, 10)},
		{"if-none-match", "*"},
		{"x-amz-meta-podhub-upload", marker},
	}
	putURL, err := presign(account, methodPut, destination, verified.ContentType, d.now(), headTTL, nil, headers)
	if err != nil {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	sent := map[string]string{
		"content-type": verified.ContentType, "content-length": strconv.FormatUint(verified.ByteLength, 10),
		"if-none-match": "*", "x-amz-meta-podhub-upload": marker,
	}
	putStatus, _, _, err := d.exchange(ctx, methodPut, putURL, sent, body, confirmTimeout, true, true, 0)
	if err != nil {
		return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	if putStatus >= 200 && putStatus < 300 {
		return nil
	}
	if putStatus == statusPrecond {
		ok, again := d.confirmed(ctx, account, destination, marker, verified)
		if again != nil {
			return again
		}
		if ok {
			return nil
		}
		return fail(409, "CONFLICT", "同名文件已存在，请更换名称；不会覆盖已有文件")
	}
	return fail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
}
