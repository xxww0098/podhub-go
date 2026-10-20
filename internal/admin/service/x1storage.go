package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// These routes do not delete stage objects, so they do not read the
// already-parsed media purge switch. They also do not call Seller.

func (s Service) callOrigin(ctx context.Context, account sign.Account, method, key, contentType string, expires time.Duration, query, headers [][2]string, body []byte, timeout time.Duration) (ObjectResponse, error) {
	if s.Origin == nil {
		return ObjectResponse{}, storageDown()
	}
	rawURL, _, err := sign.PresignURL(account, method, key, contentType, s.clock(), expires, query, headers)
	if err != nil {
		return ObjectResponse{}, storageDown()
	}
	hdr := map[string]string{}
	if contentType != "" {
		hdr["Content-Type"] = contentType
	}
	for _, h := range headers {
		hdr[h[0]] = h[1]
	}
	resp, err := s.Origin.Do(ctx, ObjectRequest{Method: method, URL: rawURL, Headers: hdr, Body: body, Timeout: timeout})
	if err != nil {
		return ObjectResponse{}, storageDown()
	}
	return resp, nil
}

func (s Service) root(account sign.Account) (string, error) {
	return domain.StorageRoot(account.KeyPrefix)
}

func (s Service) referenced(ctx context.Context, actor contract.Actor, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	cat, err := s.catalog()
	if err != nil {
		return err
	}
	var suffixes []string
	for _, key := range keys {
		suffixes = append(suffixes, "/"+sign.EncodeObjectPath(key))
	}
	hit, err := cat.Referenced(ctx, actor, suffixes)
	if err != nil {
		return err
	}
	if hit {
		return &contract.Fail{Kind: contract.KindConflict, Message: "对象仍被平台货源商品引用；请先移除 URL 引用再操作"}
	}
	return nil
}

func (s Service) CreateDirectory(ctx context.Context, actor contract.Actor, body []byte) (domain.DirectoryCreated, error) {
	path, err := domain.DecodeDirectory(body)
	if err != nil {
		return domain.DirectoryCreated{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.DirectoryCreated{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.DirectoryCreated{}, err
	}
	key := root + path + "/"
	resp, err := s.callOrigin(ctx, account, "PUT", key, "application/x-directory", 300*time.Second, nil, nil, nil, 30*time.Second)
	if err != nil {
		return domain.DirectoryCreated{}, err
	}
	if resp.Status == 503 {
		return domain.DirectoryCreated{}, &contract.Fail{Kind: contract.KindUnavailable, Message: "服务暂不可用"}
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return domain.DirectoryCreated{}, unavailable(nil)
	}
	return domain.DirectoryCreated{Path: path}, nil
}

func (s Service) ListObjects(ctx context.Context, actor contract.Actor, prefix string, cursor *string) (domain.StoragePage, error) {
	if err := domain.SupplierCursor(cursor); err != nil {
		return domain.StoragePage{}, err
	}
	rel, err := domain.SupplierPath(prefix, true)
	if err != nil {
		return domain.StoragePage{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.StoragePage{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.StoragePage{}, err
	}
	s3Prefix := root
	if rel != "" {
		s3Prefix = root + rel + "/"
	}
	query := [][2]string{{"list-type", "2"}, {"max-keys", "1000"}, {"delimiter", "/"}}
	if s3Prefix != "" {
		query = append(query, [2]string{"prefix", s3Prefix})
	}
	if cursor != nil {
		query = append(query, [2]string{"continuation-token", *cursor})
	}
	resp, err := s.callOrigin(ctx, account, "GET", "", "", 60*time.Second, query, nil, nil, 30*time.Second)
	if err != nil {
		return domain.StoragePage{}, err
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return domain.StoragePage{}, storageDown()
	}
	return domain.ProjectStorage(root, rel, account.PublicBaseURL, string(resp.Body)), nil
}

func (s Service) DeleteObjects(ctx context.Context, actor contract.Actor, body []byte) (domain.DeleteTally, error) {
	in, err := domain.DecodeDelete(body)
	if err != nil {
		return domain.DeleteTally{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.DeleteTally{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.DeleteTally{}, err
	}
	var keys []string
	more := false
	if in.Kind == "file" {
		keys = []string{root + in.Path}
	} else {
		prefix := root + in.Path + "/"
		resp, err := s.callOrigin(ctx, account, "GET", "", "", 60*time.Second, [][2]string{
			{"list-type", "2"}, {"max-keys", "501"}, {"prefix", prefix},
		}, nil, nil, 30*time.Second)
		if err != nil {
			return domain.DeleteTally{}, err
		}
		if resp.Status < 200 || resp.Status >= 300 {
			return domain.DeleteTally{}, storageDown()
		}
		listed, _, truncated := domain.ListedKeys(string(resp.Body))
		for _, key := range listed {
			if domain.IsReserved(key) {
				return domain.DeleteTally{}, &contract.Fail{Kind: contract.KindValidation, Message: "该路径为上传暂存或确认事实保留路径"}
			}
		}
		more = truncated || len(listed) > 500
		if len(listed) > 500 {
			listed = listed[:500]
		}
		keys = listed
	}
	if err := s.referenced(ctx, actor, keys...); err != nil {
		return domain.DeleteTally{}, err
	}
	tally := domain.DeleteTally{Path: in.Path, Kind: in.Kind}
	for _, key := range keys {
		resp, err := s.callOrigin(ctx, account, "DELETE", key, "", 60*time.Second, nil, nil, nil, 30*time.Second)
		switch {
		case err != nil:
			tally.Failed++
		case resp.Status >= 200 && resp.Status < 300:
			tally.Deleted++
		case resp.Status == 404:
			tally.Missing++
		default:
			tally.Failed++
		}
	}
	tally.Remaining = domain.Remaining(more, tally.Failed)
	return tally, nil
}

func (s Service) MoveObject(ctx context.Context, actor contract.Actor, body []byte) (domain.MovedObject, error) {
	in, err := domain.DecodeMove(body)
	if err != nil {
		return domain.MovedObject{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.MovedObject{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.MovedObject{}, err
	}
	source := root + in.Source
	dest := root + in.Destination
	if err := s.referenced(ctx, actor, source, dest); err != nil {
		return domain.MovedObject{}, err
	}
	copySource := "/" + sign.EncodePathSegment(account.Bucket) + "/" + sign.EncodeObjectPath(source)
	resp, err := s.callOrigin(ctx, account, "PUT", dest, "", 60*time.Second, nil, [][2]string{{"x-amz-copy-source", copySource}}, nil, 60*time.Second)
	if err != nil {
		return domain.MovedObject{}, err
	}
	if resp.Status == 404 {
		return domain.MovedObject{}, &contract.Fail{Kind: contract.KindNotFound, Message: "对象不存在"}
	}
	if resp.Status < 200 || resp.Status >= 300 || bytes.Contains(resp.Body, []byte("<Error>")) || bytes.Contains(resp.Body, []byte("<Error ")) {
		return domain.MovedObject{}, storageDown()
	}
	del, err := s.callOrigin(ctx, account, "DELETE", source, "", 60*time.Second, nil, nil, nil, 30*time.Second)
	if err != nil || (del.Status != 404 && (del.Status < 200 || del.Status >= 300)) {
		return domain.MovedObject{}, storageDown()
	}
	return domain.MovedObject{SourcePath: in.Source, DestinationPath: in.Destination}, nil
}

func (s Service) IssueStorageUpload(ctx context.Context, actor contract.Actor, body []byte, checksumHeader string) (domain.UploadBody, error) {
	in, err := domain.DecodeStorageUpload(body)
	if err != nil {
		return domain.UploadBody{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.UploadBody{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.UploadBody{}, err
	}
	final := root + in.Path
	if err := s.referenced(ctx, actor, final); err != nil {
		return domain.UploadBody{}, err
	}
	head, err := s.callOrigin(ctx, account, "HEAD", final, "", 60*time.Second, nil, nil, nil, 30*time.Second)
	if err != nil {
		return domain.UploadBody{}, err
	}
	if head.Status >= 200 && head.Status < 300 {
		return domain.UploadBody{}, &contract.Fail{Kind: contract.KindConflict, Message: "同名文件已存在，请更换名称；不会覆盖已有文件"}
	}
	if head.Status != 404 {
		return domain.UploadBody{}, storageDown()
	}
	publicID, err := s.publicID()
	if err != nil {
		return domain.UploadBody{}, unavailable(err)
	}
	stage := root + ".direct-uploads/" + publicID
	now := s.clock()
	issued, err := domain.IssueUpload(account, domain.PurposeForKey(final), actor.UserID, stage, in.ContentType, in.SHA256, in.Bytes, now, wantsStoreChecksum(checksumHeader))
	if err != nil {
		return domain.UploadBody{}, err
	}
	return uploadFromIssued(issued, now), nil
}

func uploadFromIssued(issued domain.IssuedUpload, now time.Time) domain.UploadBody {
	body := domain.UploadBody{UploadTicket: issued.Ticket}
	if issued.Grant != nil {
		body.Upload = &domain.BrowserGrant{
			URL: issued.Grant.URL,
			Headers: domain.GrantHeaders{
				ContentType: issued.Grant.ContentType,
				IfNoneMatch: issued.Grant.IfNoneMatch,
				Checksum:    issued.Grant.ChecksumSHA256,
			},
			ExpiresAtMs: (now.Unix() + int64(sign.PutTTL/time.Second)) * 1000,
		}
	}
	return body
}

func (s Service) ConfirmStorageUpload(ctx context.Context, actor contract.Actor, body []byte) (domain.ConfirmedUpload, error) {
	in, err := domain.DecodeConfirmTree(body)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	final := root + in.Path
	receipt, err := domain.OpenTicket(account, in.Ticket, domain.PurposeForKey(final), actor.UserID, s.clock())
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if !strings.HasPrefix(receipt.Key, root+".direct-uploads/") {
		return domain.ConfirmedUpload{}, &contract.Fail{Kind: contract.KindValidation, Message: "上传暂存键无效"}
	}
	replay, err := s.replay(ctx, account, final, receipt)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if replay {
		receipt.Key = final
		if _, err := s.verifyObject(ctx, account, receipt); err != nil {
			return domain.ConfirmedUpload{}, err
		}
	} else {
		if err := s.referenced(ctx, actor, final); err != nil {
			return domain.ConfirmedUpload{}, err
		}
		if _, err := s.verifyObject(ctx, account, receipt); err != nil {
			return domain.ConfirmedUpload{}, err
		}
	}
	account, err = s.storageAccount(ctx)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if _, err := domain.OpenTicket(account, in.Ticket, domain.PurposeForKey(final), actor.UserID, s.clock()); err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if receipt.StorageIdentity != domain.StorageIdentity(account) {
		return domain.ConfirmedUpload{}, &contract.Fail{Kind: contract.KindConflict, Message: "存储配置已变更，请重新选择文件"}
	}
	if !replay {
		if err := s.referenced(ctx, actor, final); err != nil {
			return domain.ConfirmedUpload{}, err
		}
		if err := s.promote(ctx, account, receipt, final); err != nil {
			return domain.ConfirmedUpload{}, err
		}
	}
	return domain.ConfirmedUpload{Key: final, PublicURL: sign.PublicURL(account, final)}, nil
}

func (s Service) replay(ctx context.Context, account sign.Account, key string, receipt domain.UploadReceipt) (bool, error) {
	resp, err := s.callOrigin(ctx, account, "HEAD", key, "", 60*time.Second, nil, nil, nil, 30*time.Second)
	if err != nil {
		return false, err
	}
	if resp.Status == 404 {
		return false, nil
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return false, storageDown()
	}
	marker := domain.PromotionMarker(account.SecretAccessKey, receipt.StorageIdentity, receipt.Key, key, receipt.SHA256, receipt.ContentType, receipt.ByteLength)
	if header(resp, "x-amz-meta-podhub-upload") == marker && header(resp, "content-type") == receipt.ContentType && header(resp, "content-length") == strconv.FormatUint(receipt.ByteLength, 10) {
		return true, nil
	}
	return false, nil
}

func (s Service) verifyObject(ctx context.Context, account sign.Account, receipt domain.UploadReceipt) ([]byte, error) {
	resp, err := s.callOrigin(ctx, account, "GET", receipt.Key, "", 300*time.Second, nil, nil, nil, 30*time.Second)
	if err != nil {
		return nil, err
	}
	if resp.Status == 404 {
		return nil, &contract.Fail{Kind: contract.KindNotFound, Code: "UPLOAD_OBJECT_MISSING", Message: "上传对象尚不存在"}
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return nil, storageDown()
	}
	if got := header(resp, "content-length"); got != "" && got != strconv.FormatUint(receipt.ByteLength, 10) {
		return nil, &contract.Fail{Kind: contract.KindConflict, Message: "上传对象长度与授权不一致"}
	}
	gotType := header(resp, "content-type")
	if i := strings.IndexByte(gotType, ';'); i >= 0 {
		gotType = strings.TrimSpace(gotType[:i])
	}
	if gotType != "" && gotType != receipt.ContentType {
		return nil, &contract.Fail{Kind: contract.KindConflict, Message: "上传对象文件类型与授权不一致"}
	}
	if uint64(len(resp.Body)) != receipt.ByteLength {
		return nil, &contract.Fail{Kind: contract.KindConflict, Message: "上传对象校验不一致，请勿覆盖该对象"}
	}
	sum := sha256.Sum256(resp.Body)
	if hex.EncodeToString(sum[:]) != strings.ToLower(receipt.SHA256) {
		return nil, &contract.Fail{Kind: contract.KindConflict, Message: "上传对象校验不一致，请勿覆盖该对象"}
	}
	if err := domain.MagicOK(receipt.ContentType, resp.Body); err != nil {
		return nil, err
	}
	return resp.Body, nil
}

func (s Service) promote(ctx context.Context, account sign.Account, receipt domain.UploadReceipt, dest string) error {
	head, err := s.callOrigin(ctx, account, "HEAD", dest, "", 60*time.Second, nil, nil, nil, 30*time.Second)
	if err != nil {
		return err
	}
	marker := domain.PromotionMarker(account.SecretAccessKey, receipt.StorageIdentity, receipt.Key, dest, receipt.SHA256, receipt.ContentType, receipt.ByteLength)
	if head.Status >= 200 && head.Status < 300 {
		if header(head, "x-amz-meta-podhub-upload") == marker && header(head, "content-length") == strconv.FormatUint(receipt.ByteLength, 10) && header(head, "content-type") == receipt.ContentType {
			return nil
		}
		return &contract.Fail{Kind: contract.KindConflict, Message: "同名文件已存在，请更换名称；不会覆盖已有文件"}
	}
	if head.Status != 404 {
		return storageDown()
	}
	body, err := s.verifyObject(ctx, account, receipt)
	if err != nil {
		return err
	}
	headers := [][2]string{
		{"content-length", strconv.FormatUint(receipt.ByteLength, 10)},
		{"if-none-match", "*"},
		{"x-amz-meta-podhub-upload", marker},
	}
	put, err := s.callOrigin(ctx, account, "PUT", dest, receipt.ContentType, sign.PutTTL, nil, headers, body, 60*time.Second)
	if err != nil {
		return err
	}
	if put.Status == 412 {
		again, err := s.callOrigin(ctx, account, "HEAD", dest, "", 60*time.Second, nil, nil, nil, 30*time.Second)
		if err != nil {
			return err
		}
		if header(again, "x-amz-meta-podhub-upload") == marker {
			return nil
		}
		return &contract.Fail{Kind: contract.KindConflict, Message: "同名文件已存在，请更换名称；不会覆盖已有文件"}
	}
	if put.Status < 200 || put.Status >= 300 {
		return storageDown()
	}
	return nil
}

func header(resp ObjectResponse, name string) string {
	if resp.Headers == nil {
		return ""
	}
	if v, ok := resp.Headers[name]; ok {
		return v
	}
	return resp.Headers[strings.ToLower(name)]
}

func (s Service) IssueRowUpload(ctx context.Context, actor contract.Actor, sourceID string, body []byte, checksumHeader string) (domain.UploadBody, error) {
	in, err := domain.DecodeStorageUpload(body)
	if err != nil {
		return domain.UploadBody{}, err
	}
	ext, err := domain.FileExt(in.Path)
	if err != nil {
		return domain.UploadBody{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.UploadBody{}, err
	}
	if _, err := cat.Detail(ctx, actor, sourceID, s.nowMs()); err != nil {
		return domain.UploadBody{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.UploadBody{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.UploadBody{}, err
	}
	now := s.clock()
	if domain.LargePSD(ext, in.Bytes) {
		return s.issueLargePSD(ctx, actor, account, root, sourceID, in, now)
	}
	a, err := s.publicID()
	if err != nil {
		return domain.UploadBody{}, unavailable(err)
	}
	b, err := s.publicID()
	if err != nil {
		return domain.UploadBody{}, unavailable(err)
	}
	name := strings.ReplaceAll(a, "-", "") + strings.ReplaceAll(b, "-", "")
	key := root + "supplier-dbs/" + sourceID + "/" + name + "." + ext
	issued, err := domain.IssueUpload(account, domain.PurposeForKey(key), actor.UserID, key, in.ContentType, in.SHA256, in.Bytes, now, wantsStoreChecksum(checksumHeader))
	if err != nil {
		return domain.UploadBody{}, err
	}
	return uploadFromIssued(issued, now), nil
}

func (s Service) issueLargePSD(ctx context.Context, actor contract.Actor, account sign.Account, root, sourceID string, in domain.StorageUpload, now time.Time) (domain.UploadBody, error) {
	lengths, err := domain.PartPlan(in.Bytes)
	if err != nil {
		return domain.UploadBody{}, err
	}
	key := root + "supplier-dbs/" + sourceID + "/" + strings.ToLower(in.SHA256) + ".psd"
	created, err := s.callOrigin(ctx, account, "POST", key, "", 60*time.Second, [][2]string{{"uploads", ""}}, nil, nil, 30*time.Second)
	if err != nil {
		return domain.UploadBody{}, err
	}
	if created.Status < 200 || created.Status >= 300 {
		return domain.UploadBody{}, storageDown()
	}
	uploadID := between(string(created.Body), "<UploadId>", "</UploadId>")
	if err := domain.UploadIDOK(uploadID); err != nil {
		return domain.UploadBody{}, err
	}
	issued, err := domain.IssueMultipart(account, domain.PurposeForKey(key), actor.UserID, key, in.ContentType, in.SHA256, uploadID, in.Bytes, partBytes, now)
	if err != nil {
		return domain.UploadBody{}, err
	}
	plan := domain.MultipartPlan{UploadID: uploadID, Ticket: issued.Ticket, PartSize: partBytes}
	for i, n := range lengths {
		rawURL, _, err := sign.PresignURL(account, "PUT", key, "application/octet-stream", now, time.Hour, [][2]string{
			{"partNumber", strconv.Itoa(i + 1)}, {"uploadId", uploadID},
		}, [][2]string{{"content-length", strconv.FormatUint(n, 10)}})
		if err != nil {
			return domain.UploadBody{}, storageDown()
		}
		plan.Parts = append(plan.Parts, domain.UploadPart{
			PartNumber: i + 1, URL: rawURL, ByteLength: n, ExpiresAtMs: now.UnixMilli() + 3_600_000,
		})
	}
	return domain.UploadBody{UploadTicket: issued.Ticket, Multipart: &plan}, nil
}

const partBytes = uint64(16 * 1024 * 1024)

func (s Service) AbortRowUpload(ctx context.Context, actor contract.Actor, sourceID string, body []byte) error {
	ticket, err := domain.DecodeAbort(body)
	if err != nil {
		return err
	}
	if strings.TrimSpace(ticket) == "" {
		return nil
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return err
	}
	receipt, err := domain.OpenSealed(account, ticket, actor.UserID, s.clock())
	if err != nil || receipt.MultipartUploadID == "" {
		return nil
	}
	resp, err := s.callOrigin(ctx, account, "DELETE", receipt.Key, "", 60*time.Second, [][2]string{{"uploadId", receipt.MultipartUploadID}}, nil, nil, 30*time.Second)
	if err != nil {
		return err
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return storageDown()
	}
	return nil
}

func (s Service) ConfirmRowUpload(ctx context.Context, actor contract.Actor, sourceID string, body []byte) (domain.ConfirmedUpload, error) {
	in, err := domain.DecodeConfirmRow(body)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	account, err := s.storageAccount(ctx)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	root, err := s.root(account)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	prefix := root + "supplier-dbs/" + sourceID + "/"
	receipt, err := openRowTicket(account, in.Ticket, actor.UserID, s.clock(), prefix)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if receipt.MultipartUploadID != "" {
		lengths, err := domain.PartPlan(receipt.ByteLength)
		if err != nil {
			return domain.ConfirmedUpload{}, err
		}
		if err := domain.CheckParts(in.Parts, len(lengths)); err != nil {
			return domain.ConfirmedUpload{}, err
		}
		if err := s.completeMultipart(ctx, account, receipt, in.Parts); err != nil {
			return domain.ConfirmedUpload{}, err
		}
	}
	if _, err := s.verifyObject(ctx, account, receipt); err != nil {
		return domain.ConfirmedUpload{}, err
	}
	account, err = s.storageAccount(ctx)
	if err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if _, err := openRowTicket(account, in.Ticket, actor.UserID, s.clock(), prefix); err != nil {
		return domain.ConfirmedUpload{}, err
	}
	if receipt.StorageIdentity != domain.StorageIdentity(account) {
		return domain.ConfirmedUpload{}, &contract.Fail{Kind: contract.KindConflict, Message: "存储配置已变更，请重新选择文件"}
	}
	if err := s.writeSidecar(ctx, account, receipt, actor.UserID, in.Ticket); err != nil {
		return domain.ConfirmedUpload{}, err
	}
	return domain.ConfirmedUpload{Key: receipt.Key, PublicURL: sign.PublicURL(account, receipt.Key)}, nil
}

func between(s, start, end string) string {
	i := strings.Index(s, start)
	if i < 0 {
		return ""
	}
	s = s[i+len(start):]
	j := strings.Index(s, end)
	if j < 0 {
		return ""
	}
	return s[:j]
}

func openRowTicket(account sign.Account, ticket string, actor int64, now time.Time, prefix string) (domain.UploadReceipt, error) {
	raw, err := domain.OpenSealed(account, ticket, actor, now)
	if err != nil {
		return domain.UploadReceipt{}, err
	}
	if !strings.HasPrefix(raw.Key, prefix) || raw.Purpose != domain.PurposeForKey(raw.Key) {
		return domain.UploadReceipt{}, &contract.Fail{Kind: contract.KindValidation, Message: "上传凭据无效或已过期，请重新选择文件"}
	}
	return raw, nil
}

func (s Service) completeMultipart(ctx context.Context, account sign.Account, receipt domain.UploadReceipt, parts []domain.PartETag) error {
	var buf bytes.Buffer
	buf.WriteString("<CompleteMultipartUpload>")
	for _, part := range parts {
		fmt.Fprintf(&buf, "<Part><PartNumber>%d</PartNumber><ETag>%s</ETag></Part>", part.Number, domain.QuoteETag(part.ETag))
	}
	buf.WriteString("</CompleteMultipartUpload>")
	resp, err := s.callOrigin(ctx, account, "POST", receipt.Key, "application/xml", 60*time.Second, [][2]string{{"uploadId", receipt.MultipartUploadID}}, nil, buf.Bytes(), 60*time.Second)
	if err != nil {
		return err
	}
	if resp.Status < 200 || resp.Status >= 300 || bytes.Contains(resp.Body, []byte("<Error>")) {
		return storageDown()
	}
	return nil
}

func (s Service) writeSidecar(ctx context.Context, account sign.Account, receipt domain.UploadReceipt, actor int64, token string) error {
	body := []byte(domain.JSONText(struct {
		ActorID int64  `json:"actor_id"`
		Token   string `json:"token"`
	}{actor, token}))
	key := receipt.Key + ".verified"
	headers := [][2]string{
		{"content-length", strconv.Itoa(len(body))},
		{"if-none-match", "*"},
	}
	resp, err := s.callOrigin(ctx, account, "PUT", key, "application/json", 60*time.Second, nil, headers, body, 30*time.Second)
	if err != nil {
		return err
	}
	if resp.Status == 412 {
		prev, err := s.callOrigin(ctx, account, "GET", key, "", 60*time.Second, nil, nil, nil, 30*time.Second)
		if err != nil {
			return err
		}
		if prev.Status >= 200 && prev.Status < 300 && bytes.Equal(bytes.TrimSpace(prev.Body), body) {
			return nil
		}
		return &contract.Fail{Kind: contract.KindConflict, Message: "上传确认事实不一致"}
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return storageDown()
	}
	return nil
}
