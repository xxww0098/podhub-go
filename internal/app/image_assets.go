package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/xxww0098/podhub-go/internal/ai"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	registry "github.com/xxww0098/podhub-go/internal/media/service/registry"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type registryImageAssets struct {
	service      registry.Service
	account      registry.Account
	client       *http.Client
	publicClient *http.Client
}
type imageBucket struct{ account registry.Account }

func (b imageBucket) Bucket(_ context.Context, role media.Role) (registry.Account, error) {
	if role != media.RoleAssets {
		return registry.Account{}, errors.New("image bucket role")
	}
	return b.account, nil
}

type imageSigner struct{}

func imageSignAccount(a registry.Account) sign.Account {
	return sign.Account{ID: a.ID, Provider: sign.Provider(a.Provider), Endpoint: a.Endpoint, Region: a.Region, Bucket: a.Bucket, KeyPrefix: a.KeyPrefix, PublicBaseURL: a.PublicBaseURL, ForcePathStyle: a.ForcePathStyle, AccessKeyID: a.AccessKeyID, SecretAccessKey: a.SecretAccessKey, SessionToken: a.SessionToken}
}
func (imageSigner) PresignPut(a registry.Account, key, kind string, size int64, digest string, now time.Time) (registry.Grant, error) {
	g, e := sign.SignPut(imageSignAccount(a), key, kind, uint64(size), now, digest, nil)
	if e != nil {
		return registry.Grant{}, e
	}
	if g.ChecksumSHA256 == "" {
		return registry.Grant{}, registry.ErrChecksum
	}
	return registry.Grant{URL: g.URL, ContentType: g.ContentType, IfNoneMatch: g.IfNoneMatch, ChecksumSHA256: g.ChecksumSHA256, ExpiresAt: g.ExpiresAt}, nil
}
func (imageSigner) PresignGet(a registry.Account, key string, now time.Time, ttl time.Duration, filename, kind string) (string, error) {
	raw, _, err := sign.PresignURL(imageSignAccount(a), http.MethodGet, key, "", now, ttl, nil, nil)
	return raw, err
}

// NewRegistryImageAssets is shared by the configured runtime and integration
// tests. Production passes only a validated assets account and the pinned client.
func NewRegistryImageAssets(pool *pgxpool.Pool, account registry.Account, client *http.Client) ai.ImageAssets {
	publicClient := client
	if client == nil {
		client = ai.ImageNetworkClient()
		if base, err := url.Parse(account.PublicBaseURL); err == nil && base.Hostname() != "" {
			publicClient = ai.NewImageClient(base.Hostname())
		}
	}
	return registryImageAssets{service: registry.Service{Store: mediarepo.New(pool, tenantx.BeginApp), Signer: imageSigner{}, Buckets: imageBucket{account}}, account: account, client: client, publicClient: publicClient}
}

func (s registryImageAssets) Save(ctx context.Context, org, user int64, pixels []byte) (ai.ImageAsset, error) {
	if s.publicClient == nil || s.account.PublicBaseURL == "" {
		return ai.ImageAsset{}, errors.New("image public storage unavailable")
	}
	if org <= 0 || user <= 0 || len(pixels) == 0 || len(pixels) > storedImageByteLimit {
		return ai.ImageAsset{}, errors.New("image asset input")
	}
	digest := storedImageDigest(pixels)
	target, err := s.service.Presign(ctx, registry.PresignRequest{ActorID: user, OrgID: org, Purpose: media.PurposeListingImage, SHA256Hex: digest, ByteLength: int64(len(pixels)), Extension: "jpg"})
	if err != nil {
		return ai.ImageAsset{}, err
	}
	if !target.Reuse {
		if target.Grant == nil {
			return ai.ImageAsset{}, errors.New("image upload grant missing")
		}
		req, e := http.NewRequestWithContext(ctx, http.MethodPut, target.Grant.URL, bytes.NewReader(pixels))
		if e != nil {
			return ai.ImageAsset{}, e
		}
		req.Header.Set("Content-Type", target.Grant.ContentType)
		req.Header.Set("If-None-Match", target.Grant.IfNoneMatch)
		req.Header.Set("X-Amz-Checksum-Sha256", target.Grant.ChecksumSHA256)
		resp, e := s.client.Do(req)
		if e != nil {
			return ai.ImageAsset{}, errors.New("image upload outcome unknown")
		}
		resp.Body.Close()
		// A precondition response can mean an earlier PUT reached the store. Never
		// upload again: verify its bytes and checksum using the original grant.
		if resp.StatusCode != 200 && resp.StatusCode != 201 && resp.StatusCode != 204 && resp.StatusCode != 412 {
			return ai.ImageAsset{}, errors.New("image upload refused")
		}
	}
	proof, err := s.readback(ctx, target.ObjectKey, digest, int64(len(pixels)))
	if err != nil {
		return ai.ImageAsset{}, err
	}
	if !target.Reuse {
		target, err = s.service.Confirm(ctx, registry.ConfirmRequest{ActorID: user, OrgID: org, UploadID: target.UploadID}, func(context.Context, registry.UploadRow) (registry.Object, error) { return proof, nil })
		if err != nil {
			return ai.ImageAsset{}, err
		}
	}
	if target.ObjectID == "" {
		return ai.ImageAsset{}, errors.New("image object confirmation missing")
	}
	return ai.ImageAsset{ObjectID: target.ObjectID, URL: target.PublicURL, SHA256: digest}, nil
}

func (s registryImageAssets) readback(ctx context.Context, key, digest string, size int64) (registry.Object, error) {
	a := imageSignAccount(s.account)
	headURL, _, err := sign.PresignURL(a, http.MethodHead, key, "", time.Now(), time.Minute, nil, [][2]string{{"x-amz-checksum-mode", "ENABLED"}})
	if err != nil {
		return registry.Object{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, headURL, nil)
	if err != nil {
		return registry.Object{}, err
	}
	req.Header.Set("X-Amz-Checksum-Mode", "ENABLED")
	response, err := s.client.Do(req)
	if err != nil {
		return registry.Object{}, errors.New("image HEAD unavailable")
	}
	response.Body.Close()
	rawChecksum := response.Header.Get("X-Amz-Checksum-Sha256")
	checksum, hasChecksum := sign.FullObjectSHA256(rawChecksum)
	length, lengthErr := strconv.ParseInt(response.Header.Get("Content-Length"), 10, 64)
	kind, _, typeErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != 200 || (hasChecksum && checksum != digest) || lengthErr != nil || length != size || typeErr != nil || kind != "image/jpeg" {
		return registry.Object{}, errors.New("image HEAD mismatch")
	}
	getURL, _, err := sign.PresignURL(a, http.MethodGet, key, "", time.Now(), time.Minute, nil, nil)
	if err != nil {
		return registry.Object{}, err
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, getURL, nil)
	if err != nil {
		return registry.Object{}, err
	}
	response, err = s.client.Do(req)
	if err != nil {
		return registry.Object{}, errors.New("image readback unavailable")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, storedImageByteLimit+1))
	if err != nil || response.StatusCode != 200 || int64(len(body)) != size || storedImageDigest(body) != digest {
		return registry.Object{}, errors.New("image readback mismatch")
	}
	publicRequest, e := http.NewRequestWithContext(ctx, http.MethodGet, s.account.PublicURL(key), nil)
	if e != nil {
		return registry.Object{}, e
	}
	publicResponse, e := s.publicClient.Do(publicRequest)
	if e != nil {
		return registry.Object{}, errors.New("public image unavailable")
	}
	defer publicResponse.Body.Close()
	publicBytes, e := io.ReadAll(io.LimitReader(publicResponse.Body, storedImageByteLimit+1))
	if e != nil || publicResponse.StatusCode != 200 || int64(len(publicBytes)) != size || storedImageDigest(publicBytes) != digest {
		return registry.Object{}, errors.New("public image readback mismatch")
	}
	return registry.Object{Exists: true, ByteLength: size, ContentType: kind, SHA256Hex: checksum, ReadbackSHA256Hex: storedImageDigest(body)}, nil
}

const storedImageByteLimit = 20 << 20

func storedImageDigest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
