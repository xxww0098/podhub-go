package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type adminTickets struct{}

func signAccount(account domain.CloudAccount) sign.Account {
	return sign.Account{
		ID: account.ID, Provider: sign.Provider(account.Provider), Endpoint: account.Endpoint,
		Region: account.Region, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix,
		PublicBaseURL: account.PublicBaseURL, ForcePathStyle: account.ForcePathStyle,
		AccessKeyID: account.AccessKeyID, SecretAccessKey: account.SecretAccessKey,
		SessionToken: account.SessionToken,
	}
}

func (adminTickets) Issue(account domain.CloudAccount, actorID int64, purpose, stage, contentType, sha string, n uint64, checksum bool, now time.Time) (service.Issued, error) {
	target, err := receipt.Issue(signAccount(account), receipt.Subject{Purpose: purpose, ActorID: actorID}, receipt.Object{
		Key: stage, ContentType: contentType, ByteLength: n, SHA256: sha,
	}, now, checksum, nil)
	if err != nil {
		return service.Issued{}, mapTicket(err)
	}
	return service.Issued{
		URL: target.Grant.URL, ContentType: target.Grant.ContentType, IfNoneMatch: target.Grant.IfNoneMatch,
		Checksum: target.Grant.ChecksumSHA256, ExpiresAtMS: target.Grant.ExpiresAt.UnixMilli(), Ticket: target.Ticket,
	}, nil
}

func (adminTickets) Verify(account domain.CloudAccount, actorID int64, purpose, token string, now time.Time) (service.Verified, error) {
	body, err := receipt.Verify(signAccount(account), token, receipt.Subject{Purpose: purpose, ActorID: actorID}, now)
	if err != nil {
		return service.Verified{}, mapTicket(err)
	}
	return service.Verified{
		Key: body.Key, ContentType: body.ContentType, SHA256: body.SHA256, ByteLength: body.ByteLength,
		StorageIdentity: body.StorageIdentity, ChecksumEnforced: body.ChecksumEnforced,
	}, nil
}

func (adminTickets) Identity(account domain.CloudAccount) string {
	return receipt.StorageIdentity(signAccount(account))
}

func (adminTickets) Marker(account domain.CloudAccount, identity, receiptKey, destination, sha, contentType string, n uint64) (string, error) {
	secret := strings.TrimSpace(account.SecretAccessKey)
	if secret == "" {
		return "", service.NewFail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	payload, err := jsonwire.Marshal([]any{identity, receiptKey, destination, sha, n, contentType})
	if err != nil {
		return "", service.NewFail(503, "UNAVAILABLE", "对象存储确认暂不可用，请重试确认")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("podhub/admin-upload-promotion/v1\x00"))
	_, _ = mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func mapTicket(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, receipt.ErrInvalid) {
		return service.NewFail(400, "VALIDATION", receipt.ErrInvalid.Error())
	}
	if errors.Is(err, receipt.ErrUnavailable) {
		return service.NewFail(503, "UNAVAILABLE", receipt.ErrUnavailable.Error())
	}
	var signed sign.Error
	if errors.As(err, &signed) {
		switch signed.Message {
		case "浏览器直传需要 HTTPS 对象存储地址":
			return service.NewFail(503, "UNAVAILABLE", signed.Message)
		case "上传大小或文件类型无效":
			return service.NewFail(400, "VALIDATION", signed.Message)
		case "上传目标有效期已过期":
			return service.NewFail(409, "CONFLICT", signed.Message)
		default:
			slog.Error(signed.Message)
			return service.NewFail(500, "INTERNAL", "服务暂不可用")
		}
	}
	slog.Error("admin upload ticket", "err", err)
	return service.NewFail(500, "INTERNAL", "服务暂不可用")
}
