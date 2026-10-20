package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const (
	catalogWorkspace = "00000000-0000-4000-8000-000000000000"
	receiptTTL       = 4 * time.Hour
	putTTL           = 600 * time.Second
)

type uploadTicket struct {
	Purpose     string `json:"purpose"`
	ActorID     int64  `json:"actorId"`
	Key         string `json:"key"`
	ContentType string `json:"contentType"`
	Bytes       uint64 `json:"bytes"`
	SHA256      string `json:"sha256"`
	ExpMS       int64  `json:"expMs"`
	PublicBase  string `json:"publicBase"`
	DestID      string `json:"destId"`
}

// UploadTarget is DirectUploadTarget. False and nil optionals stay omitted.
type UploadTarget struct {
	Upload       *UploadGrant `json:"upload,omitempty"`
	UploadTicket string       `json:"uploadTicket"`
}

// UploadGrant is the browser PUT.
type UploadGrant struct {
	URL     string       `json:"url"`
	Headers UploadHeader `json:"headers"`
}

// UploadHeader carries the signed headers the browser must send.
type UploadHeader struct {
	ContentType    string `json:"contentType"`
	IfNoneMatch    string `json:"ifNoneMatch"`
	ChecksumSHA256 string `json:"checksumSha256,omitempty"`
	ExpiresAtMS    int64  `json:"expiresAtMs"`
}

// UploadResponse wraps one target.
type UploadResponse struct {
	Data UploadTarget `json:"data"`
}

// InitImage presigns a loopback PUT. It does not write the catalog or audit.
func (s *Catalog) InitImage(ctx context.Context, actor domain.Actor, kind, id string, raw []byte) (UploadResponse, error) {
	in, err := domain.ParseInitImage(raw)
	if err != nil {
		return UploadResponse{}, err
	}
	target, err := s.port.ImageTarget(ctx, kind, id)
	if err != nil {
		return UploadResponse{}, err
	}
	if !target.Exists {
		return UploadResponse{}, domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	persistent, staging, err := s.splitMedia()
	if err != nil {
		return UploadResponse{}, err
	}
	destID := destIdentity(persistent)
	replacements := []string{publicURL(persistent, nativeKey(strings.ToLower(in.File.SHA256)))}
	if err := room(target, in.Revision, replacements); err != nil {
		return UploadResponse{}, err
	}
	purpose := "platform-catalog:" + kind + ":" + id + ":" + itoa64(in.Revision) + ":" + destID
	sum := sha256.Sum256([]byte(purpose))
	key := strings.Trim(staging.Prefix, "/")
	if key != "" {
		key += "/"
	}
	key += "staging/" + hex.EncodeToString(sum[:])[:16] + "/" + itoa64(actor.UserID) + "/" + strings.TrimPrefix(s.mint("x"), "x_")
	now := time.UnixMilli(s.now())
	url, _, err := sign.PresignURL(signAccount(staging), "PUT", key, "image/jpeg", now, putTTL, nil, [][2]string{{"content-type", "image/jpeg"}})
	if err != nil {
		return UploadResponse{}, domain.Fail(503, "MEDIA_UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	ticket := uploadTicket{
		Purpose: purpose, ActorID: actor.UserID, Key: key, ContentType: "image/jpeg",
		Bytes: in.File.Bytes, SHA256: in.File.SHA256, ExpMS: now.Add(receiptTTL).UnixMilli(),
		PublicBase: persistent.PublicBaseURL, DestID: destID,
	}
	rawTicket, err := sealTicket(s.opt.TicketKey, ticket)
	if err != nil {
		return UploadResponse{}, err
	}
	return UploadResponse{Data: UploadTarget{
		Upload: &UploadGrant{URL: url, Headers: UploadHeader{
			ContentType: "image/jpeg", IfNoneMatch: "*", ExpiresAtMS: now.Add(putTTL).UnixMilli(),
		}},
		UploadTicket: rawTicket,
	}}, nil
}

// ConfirmImage reads the staged object from loopback storage and attaches the public URL.
func (s *Catalog) ConfirmImage(ctx context.Context, actor domain.Actor, kind, id string, raw []byte) (any, error) {
	in, err := domain.ParseConfirmImage(raw)
	if err != nil {
		return nil, err
	}
	persistent, staging, err := s.splitMedia()
	if err != nil {
		return nil, err
	}
	if len(s.opt.TicketKey) == 0 {
		return nil, domain.Fail(503, "MEDIA_UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	ticket, err := openTicket(s.opt.TicketKey, in.Ticket)
	if err != nil {
		return nil, domain.Fail(400, "VALIDATION", "上传凭据无效或已过期，请重新选择文件")
	}
	destID := destIdentity(persistent)
	purpose := "platform-catalog:" + kind + ":" + id + ":" + itoa64(in.Revision) + ":" + destID
	if ticket.Purpose != purpose || ticket.ActorID != actor.UserID || ticket.ContentType != "image/jpeg" || ticket.ExpMS < s.now() || ticket.DestID != destID {
		return nil, domain.Fail(400, "VALIDATION", "上传凭据无效或已过期，请重新选择文件")
	}
	target, err := s.port.ImageTarget(ctx, kind, id)
	if err != nil {
		return nil, err
	}
	replacements := []string{publicURL(persistent, nativeKey(ticket.SHA256))}
	if err := room(target, in.Revision, replacements); err != nil {
		return nil, err
	}
	if s.opt.Blobs == nil {
		return nil, domain.Fail(503, "MEDIA_UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	body, ctype, status, err := s.opt.Blobs.Get(ctx, staging, ticket.Key)
	if err != nil {
		return nil, domain.Fail(503, "MEDIA_UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	if status == 404 {
		return nil, domain.Fail(404, "NOT_FOUND", "上传对象尚不存在")
	}
	if status < 200 || status >= 300 {
		return nil, domain.Fail(503, "MEDIA_UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	if ctype != "" && !strings.HasPrefix(strings.ToLower(ctype), "image/jpeg") {
		return nil, domain.Fail(409, "CONFLICT", "上传对象文件类型与授权不一致")
	}
	if uint64(len(body)) != ticket.Bytes {
		return nil, domain.Fail(409, "CONFLICT", "上传对象长度与授权不一致")
	}
	sum := sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != ticket.SHA256 || len(body) < 2 || body[0] != 0xFF || body[1] != 0xD8 {
		return nil, domain.Fail(400, "VALIDATION", "JPEG 图片内容或尺寸无效")
	}
	durable := nativeKey(ticket.SHA256)
	putStatus, err := s.opt.Blobs.Put(ctx, persistent, durable, body, "image/jpeg")
	if err != nil || putStatus < 200 || putStatus >= 300 {
		return nil, domain.Fail(503, "MEDIA_UNAVAILABLE", "媒体源站暂不可用")
	}
	next, err := domain.ReplaceMedia(target.Media, replacements, publicURL(persistent, durable))
	if err != nil {
		return nil, err
	}
	product, sku, err := s.port.AttachMedia(ctx, s.actor(actor), kind, id, in.Revision, next, s.now())
	if err != nil {
		return nil, err
	}
	if kind == "sku" {
		var out domain.SKUMutation
		out.Data.SKU = domain.FillSKU(sku)
		return out, nil
	}
	var out domain.ProductMutation
	out.Data.Product = domain.FillProduct(product)
	return out, nil
}

func room(target domain.ImageTarget, rev int64, replacements []string) error {
	if !target.Exists {
		return domain.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	if target.Managed {
		return domain.Fail(409, "CONFLICT", "该行由平台货源管理，请在平台货源中操作")
	}
	if target.Revision != rev {
		return domain.Fail(409, "CONFLICT", "记录已被更新，请刷新后重试")
	}
	if target.MediaBad {
		return domain.Fail(400, "VALIDATION", "图片数量已达上限")
	}
	if len(target.Media) >= 20 {
		owned := false
		for _, item := range target.Media {
			for _, r := range replacements {
				if item == r {
					owned = true
				}
			}
		}
		if !owned {
			return domain.Fail(400, "VALIDATION", "图片数量已达上限")
		}
	}
	return nil
}

func (s *Catalog) splitMedia() (persistent, staging MediaAccount, err error) {
	if s.opt.Media == nil {
		return MediaAccount{}, MediaAccount{}, domain.Fail(503, "MEDIA_UNAVAILABLE", "平台尚未配置媒体存储")
	}
	var persistents []MediaAccount
	for _, a := range s.opt.Media {
		if a.Staging {
			staging = a
		}
		if a.Persistent && !a.Slice {
			persistents = append(persistents, a)
		}
	}
	if staging.Endpoint == "" {
		return MediaAccount{}, MediaAccount{}, domain.Fail(503, "MEDIA_UNAVAILABLE", "请先配置私有用户素材存储，再上传文件")
	}
	if strings.TrimSpace(staging.PublicBaseURL) != "" {
		return MediaAccount{}, MediaAccount{}, domain.Fail(503, "MEDIA_UNAVAILABLE", "暂存文件必须使用私有用户素材桶")
	}
	if !staging.Active {
		return MediaAccount{}, MediaAccount{}, domain.Fail(409, "CONFLICT", "记录已被更新，请刷新后重试")
	}
	switch len(persistents) {
	case 0:
		return MediaAccount{}, MediaAccount{}, domain.Fail(503, "MEDIA_UNAVAILABLE", "尚未配置持久媒体存储；请在上架媒体中新增独立的非切片桶账号，保留切片账号为当前账号")
	case 1:
		persistent = persistents[0]
	default:
		return MediaAccount{}, MediaAccount{}, domain.Fail(409, "CONFLICT", "存在多个持久媒体账号，请明确选择账号；自动上传需要唯一的非切片桶账号")
	}
	if strings.TrimSpace(persistent.PublicBaseURL) == "" {
		return MediaAccount{}, MediaAccount{}, domain.Fail(503, "MEDIA_UNAVAILABLE", "平台图片需要公开媒体存储")
	}
	return persistent, staging, nil
}

func destIdentity(a MediaAccount) string {
	sum := sha256.Sum256([]byte(a.Endpoint + "|" + a.Bucket + "|" + a.Prefix + ":" + strings.TrimRight(a.PublicBaseURL, "/")))
	return hex.EncodeToString(sum[:])
}

func nativeKey(digest string) string {
	return "images/teams/" + catalogWorkspace + "/sha256/" + digest + ".jpg"
}

func publicURL(a MediaAccount, key string) string {
	return strings.TrimRight(a.PublicBaseURL, "/") + "/" + strings.TrimLeft(key, "/")
}

func signAccount(a MediaAccount) sign.Account {
	return sign.Account{
		Provider: sign.ProviderGeneric, Endpoint: a.Endpoint, Region: a.Region, Bucket: a.Bucket,
		KeyPrefix: a.Prefix, PublicBaseURL: a.PublicBaseURL, ForcePathStyle: true,
		AccessKeyID: a.AccessKeyID, SecretAccessKey: a.SecretAccessKey,
	}
}

func sealTicket(key []byte, ticket uploadTicket) (string, error) {
	if len(key) == 0 {
		return "", domain.Fail(503, "MEDIA_UNAVAILABLE", "对象存储确认暂不可用，请稍后重试确认")
	}
	raw, err := json.Marshal(ticket)
	if err != nil {
		return "", domain.Fail(500, "INTERNAL", "服务暂不可用")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(raw)
	return hex.EncodeToString(raw) + "." + hex.EncodeToString(mac.Sum(nil)), nil
}

func openTicket(key []byte, raw string) (uploadTicket, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return uploadTicket{}, domain.Fail(400, "VALIDATION", "bad")
	}
	body, err := hex.DecodeString(parts[0])
	if err != nil {
		return uploadTicket{}, err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(body)
	sum, err := hex.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sum, mac.Sum(nil)) {
		return uploadTicket{}, domain.Fail(400, "VALIDATION", "bad")
	}
	var ticket uploadTicket
	if err := json.Unmarshal(body, &ticket); err != nil {
		return uploadTicket{}, err
	}
	return ticket, nil
}

func itoa64(n int64) string { return corecontract.Itoa64(n) }
