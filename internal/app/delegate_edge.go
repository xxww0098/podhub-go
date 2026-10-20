package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	mediacontract "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/checksum"
	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
)

// delegateEdge wires loopback Seller reads and the delegate asset bucket.
// Presign does not take a writer lease. Finalize and delete do, in the repository.
// Object deletes run only when the parsed media-delete switch is on, and only
// through the loopback origin client.
func delegateEdge(pool *pgxpool.Pool, cfg config.Config) delegatesvc.Edge {
	return delegatesvc.Edge{
		Storage: func(ctx context.Context) (string, int64, error) {
			account, revision, err := loadDelegateStorage(ctx, pool, cfg.IntegrationConfigKey)
			if err != nil {
				return "", 0, err
			}
			return account.KeyPrefix, revision, nil
		},
		Issue: func(ctx context.Context, in delegatesvc.Issue) (contract.UploadTarget, error) {
			account, _, err := loadDelegateStorage(ctx, pool, cfg.IntegrationConfigKey)
			if err != nil {
				return contract.UploadTarget{}, err
			}
			return issueDelegate(account, in, time.Now().UTC())
		},
		Confirm: func(ctx context.Context, purpose string, actorID, orgID int64, token string) (delegatesvc.Confirmed, error) {
			account, _, err := loadDelegateStorage(ctx, pool, cfg.IntegrationConfigKey)
			if err != nil {
				return delegatesvc.Confirmed{}, err
			}
			return confirmDelegate(ctx, account, purpose, actorID, orgID, token, time.Now().UTC())
		},
		Delete: func(ctx context.Context, key string) error {
			account, _, err := loadDelegateStorage(ctx, pool, cfg.IntegrationConfigKey)
			if err != nil {
				return err
			}
			deleteDelegate(ctx, account, key, cfg.MediaDeleteEnabled())
			return nil
		},
		Seller: func(ctx context.Context, clientID, apiKey, path string, body []byte) (int, []byte, string, error) {
			return postDelegateSeller(ctx, sellerdomain.ResolveBaseURL(cfg.SellerBaseURL()), clientID, apiKey, path, body)
		},
		Open: func(cred contract.SealedCredential) (string, string, error) {
			return openDelegateCredential(cfg, cred)
		},
	}
}

func loadDelegateStorage(ctx context.Context, pool *pgxpool.Pool, key string) (sign.Account, int64, error) {
	if pool == nil {
		return sign.Account{}, 0, contract.StorageUnavailable(contract.MsgStorageMissing)
	}
	var revision int64
	var nonce, ciphertext []byte
	err := pool.QueryRow(ctx, `
		SELECT revision, nonce, ciphertext
		  FROM public.platform_integration_config
		 WHERE singleton = true`).Scan(&revision, &nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return sign.Account{}, 0, contract.StorageUnavailable(contract.MsgStorageMissing)
	}
	if err != nil {
		return sign.Account{}, 0, contract.Internal()
	}
	account, err := accountFromSnapshot(key, nonce, ciphertext)
	if err != nil {
		return sign.Account{}, 0, err
	}
	return account, revision, nil
}

func accountFromSnapshot(key string, nonce, ciphertext []byte) (sign.Account, error) {
	kek, err := seal.IntegrationKEK(key)
	if err != nil {
		var keyErr *seal.KeyError
		if errors.As(err, &keyErr) {
			return sign.Account{}, contract.StorageUnavailable(keyErr.Message)
		}
		return sign.Account{}, contract.Internal()
	}
	plain, err := seal.OpenIntegration(kek, nonce, ciphertext)
	if err != nil {
		return sign.Account{}, contract.Internal()
	}
	stored, err := seal.ParseSnapshot(plain)
	if err != nil {
		return sign.Account{}, contract.Internal()
	}
	for _, section := range stored.Buckets {
		if section.Role != string(mediacontract.RolePrivate) || !section.Active {
			continue
		}
		return sign.Account{
			ID: section.ID, Provider: sign.Provider(section.Provider), Endpoint: section.Endpoint,
			Region: section.Region, Bucket: section.Bucket, KeyPrefix: section.KeyPrefix,
			PublicBaseURL: section.PublicBaseURL, ForcePathStyle: section.ForcePathStyle,
			AccessKeyID: section.AccessKeyID, SecretAccessKey: section.SecretAccessKey,
			SessionToken: section.SessionToken,
		}, nil
	}
	return sign.Account{}, contract.StorageUnavailable(contract.MsgStorageMissing)
}

func issueDelegate(account sign.Account, in delegatesvc.Issue, now time.Time) (contract.UploadTarget, error) {
	ws := in.WorkspaceID
	target, err := receipt.Issue(account, receipt.Subject{
		Purpose: in.Purpose, ActorID: in.ActorID, WorkspaceID: &ws,
	}, receipt.Object{
		Key: in.Key, ContentType: in.ContentType, ByteLength: in.Bytes, SHA256: in.SHA,
	}, now, in.Checksum, nil)
	if err != nil {
		return contract.UploadTarget{}, mapTicket(err)
	}
	if target.Grant == nil {
		return contract.UploadTarget{}, contract.StorageUnavailable("直传授权缺失")
	}
	var checksum *string
	if target.Grant.ChecksumSHA256 != "" {
		value := target.Grant.ChecksumSHA256
		checksum = &value
	}
	return contract.UploadTarget{
		ObjectKey: in.Key,
		Upload: contract.UploadGrant{
			URL: target.Grant.URL,
			Headers: contract.UploadHeaders{
				ContentType: target.Grant.ContentType, IfNoneMatch: target.Grant.IfNoneMatch, ChecksumSHA256: checksum,
			},
			ExpiresAtMS: target.Grant.ExpiresAt.UnixMilli(),
		},
		UploadTicket: target.Ticket,
	}, nil
}

func confirmDelegate(ctx context.Context, account sign.Account, purpose string, actorID, orgID int64, token string, now time.Time) (delegatesvc.Confirmed, error) {
	ws := orgID
	body, err := receipt.Verify(account, token, receipt.Subject{
		Purpose: purpose, ActorID: actorID, WorkspaceID: &ws,
	}, now)
	if err != nil {
		return delegatesvc.Confirmed{}, mapTicket(err)
	}
	if body.ChecksumEnforced {
		proven, err := confirmChecksumHead(ctx, account, body, now)
		if err != nil {
			return delegatesvc.Confirmed{}, err
		}
		if proven {
			return delegatesvc.Confirmed{
				Key: body.Key, SHA: body.SHA256, ContentType: body.ContentType, Bytes: int64(body.ByteLength),
			}, nil
		}
	}
	rawURL, _, err := sign.PresignURL(account, http.MethodGet, body.Key, "", now, 300*time.Second, nil, nil)
	if err != nil {
		return delegatesvc.Confirmed{}, contract.StorageUnavailable("对象存储确认暂不可用，请稍后重试确认")
	}
	resp, err := r2.Exchange(ctx, r2.Request{
		Method: http.MethodGet, URL: rawURL, Timeout: 30 * time.Second,
		NoCompress: true, StrictRead: true, MaxBytes: int64(body.ByteLength),
	})
	if resp.Status == http.StatusNotFound {
		return delegatesvc.Confirmed{}, contract.NotFound("上传对象尚不存在")
	}
	if err != nil && strings.Contains(err.Error(), "exceeds limit") {
		return delegatesvc.Confirmed{}, contract.Conflict("上传对象超过授权长度")
	}
	if err != nil {
		return delegatesvc.Confirmed{}, contract.StorageUnavailable("对象存储确认暂不可用，请稍后重试确认")
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return delegatesvc.Confirmed{}, contract.StorageUnavailable("对象存储确认暂不可用，请稍后重试确认")
	}
	if length := headerOne(resp.Header, "Content-Length"); length != "" {
		n, parseErr := strconv.ParseUint(strings.TrimSpace(length), 10, 64)
		if parseErr != nil || n != body.ByteLength {
			return delegatesvc.Confirmed{}, contract.Conflict("上传对象长度与授权不一致")
		}
	}
	gotType := headerOne(resp.Header, "Content-Type")
	if i := strings.IndexByte(gotType, ';'); i >= 0 {
		gotType = gotType[:i]
	}
	if strings.TrimSpace(gotType) != body.ContentType {
		return delegatesvc.Confirmed{}, contract.Conflict("上传对象文件类型与授权不一致")
	}
	sum := sha256.Sum256(resp.Body)
	if uint64(len(resp.Body)) != body.ByteLength || hex.EncodeToString(sum[:]) != strings.ToLower(body.SHA256) {
		return delegatesvc.Confirmed{}, contract.Conflict("上传对象校验不一致，请勿覆盖该对象")
	}
	return delegatesvc.Confirmed{
		Key: body.Key, SHA: body.SHA256, ContentType: body.ContentType, Bytes: int64(body.ByteLength),
	}, nil
}

// confirmChecksumHead is the forced-checksum arm of verify_object. A store
// checksum that matches length and type is proof. A missing full-object
// checksum falls through to the GET. Digest and length/type failures stay 409.
func confirmChecksumHead(ctx context.Context, account sign.Account, body receipt.Receipt, now time.Time) (bool, error) {
	rawURL, _, err := sign.PresignURL(account, http.MethodHead, body.Key, "", now, 300*time.Second, nil, nil)
	if err != nil {
		return false, contract.StorageUnavailable("对象存储确认暂不可用，请稍后重试确认")
	}
	resp, err := r2.Exchange(ctx, r2.Request{
		Method: http.MethodHead, URL: rawURL, Timeout: 30 * time.Second, NoCompress: true,
	})
	if err != nil {
		return false, contract.StorageUnavailable("对象存储确认暂不可用，请稍后重试确认")
	}
	if resp.Status == http.StatusNotFound {
		return false, contract.NotFound("上传对象尚不存在")
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return false, contract.StorageUnavailable("对象存储确认暂不可用，请稍后重试确认")
	}
	shaHex, hasSHA := checksum.ParseChecksumHeader(headerOne(resp.Header, "x-amz-checksum-sha256"))
	var length *uint64
	if raw := strings.TrimSpace(headerOne(resp.Header, "Content-Length")); raw != "" {
		n, parseErr := strconv.ParseUint(raw, 10, 64)
		if parseErr == nil {
			length = &n
		}
	}
	gotType := headerOne(resp.Header, "Content-Type")
	if i := strings.IndexByte(gotType, ';'); i >= 0 {
		gotType = gotType[:i]
	}
	gotType = strings.TrimSpace(gotType)
	verdict := checksum.Judge(checksum.Head{
		ByteLength: length, ContentType: gotType, SHA256Hex: shaHex,
		HasSHA256: hasSHA, HasType: gotType != "",
	}, strings.ToLower(body.SHA256), body.ByteLength, body.ContentType)
	switch verdict {
	case checksum.Trusted:
		return true, nil
	case checksum.Unproven:
		return false, nil
	default:
		if !hasSHA || shaHex != strings.ToLower(body.SHA256) {
			return false, contract.Conflict("上传对象校验不一致，请勿覆盖该对象")
		}
		return false, contract.Conflict("上传对象长度或类型与授权不一致")
	}
}

func deleteDelegate(ctx context.Context, account sign.Account, key string, allow bool) {
	if !allow {
		slog.Warn("delegate asset reclaim skipped", "key", key)
		return
	}
	rawURL, _, err := sign.PresignURL(account, http.MethodDelete, key, "", time.Now().UTC(), 600*time.Second, nil, nil)
	if err != nil {
		slog.Warn("delegate asset reclaim signing failed", "key", key, "err", err)
		return
	}
	resp, err := r2.Exchange(ctx, r2.Request{Method: http.MethodDelete, URL: rawURL, Timeout: 30 * time.Second})
	if err != nil {
		slog.Warn("delegate asset reclaim unreachable", "key", key, "err", err)
		return
	}
	if (resp.Status >= 200 && resp.Status < 300) || resp.Status == http.StatusNotFound {
		return
	}
	slog.Warn("delegate asset reclaim DELETE failed; object left for manual cleanup", "status", resp.Status, "key", key)
}

func mapTicket(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, receipt.ErrInvalid) {
		return contract.Validation(receipt.ErrInvalid.Error())
	}
	if errors.Is(err, receipt.ErrUnavailable) {
		return contract.StorageUnavailable(receipt.ErrUnavailable.Error())
	}
	var signed sign.Error
	if errors.As(err, &signed) {
		switch signed.Message {
		case "浏览器直传需要 HTTPS 对象存储地址":
			return contract.StorageUnavailable(signed.Message)
		case "上传大小或文件类型无效":
			return contract.Validation(signed.Message)
		default:
			slog.Error("delegate upload ticket", "err", signed.Message)
			return contract.Internal()
		}
	}
	return contract.Internal()
}

func headerOne(header map[string][]string, name string) string {
	for key, values := range header {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func openDelegateCredential(cfg config.Config, cred contract.SealedCredential) (string, string, error) {
	kek, err := seal.SellerKEK(cfg.SellerCredentialKey)
	if err != nil {
		return "", "", contract.Internal()
	}
	currentID := strings.TrimSpace(cfg.SellerCredentialKeyID)
	if currentID == "" {
		currentID = seal.DefaultSellerKeyID
	}
	var previous []byte
	if cred.KeyID != currentID && strings.TrimSpace(cfg.SellerCredentialKeyPrevious) != "" {
		previous, err = seal.SellerKEK(cfg.SellerCredentialKeyPrevious)
		if err != nil {
			return "", "", contract.Internal()
		}
	}
	clientID, apiKey, err := seal.OpenStored(
		currentID, cred.KeyID, kek, previous,
		cred.OrgID, cred.StorePK, cred.CredentialRevision,
		cred.Nonce, cred.Ciphertext, cred.WrappedDEK, cred.DEKNonce,
	)
	if err != nil || clientID == "" || apiKey == "" {
		return "", "", contract.Internal()
	}
	return clientID, apiKey, nil
}

// delegateSellerClient does not follow redirects and does not use a proxy.
// The 30s limit sits on the request context. This client has no Timeout.
// A 3xx is a connect failure: the body is not returned as a successful
// Seller payload. It is discarded so the connection can be reused.
var delegateSellerClient = httpx.OzonClient()

func postDelegateSeller(ctx context.Context, base, clientID, apiKey, path string, body []byte) (int, []byte, string, error) {
	if !sellerdomain.LoopbackOrigin(base + "/") {
		return 0, nil, "connect", errors.New("seller base url is not loopback")
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, "connect", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", clientID)
	req.Header.Set("Api-Key", apiKey)
	resp, err := delegateSellerClient.Do(req)
	if err != nil {
		kind := "connect"
		var netErr interface{ Timeout() bool }
		if errors.As(err, &netErr) && netErr.Timeout() || errors.Is(err, context.DeadlineExceeded) {
			kind = "timeout"
		}
		return 0, nil, kind, err
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		httpx.Discard(resp.Body)
		return 0, nil, "connect", errors.New("redirect left loopback")
	}
	raw, err := httpx.ReadLimit(resp.Body, 1<<20)
	if err != nil {
		return resp.StatusCode, nil, "decode", err
	}
	return resp.StatusCode, raw, "", nil
}
