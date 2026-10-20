// Package registry turns one presign or confirm request into a registry
// write. It never reads or writes object bytes: presign signs, confirm trusts
// the full-object checksum the store echoes, and the browser uploads directly
// to the final key.
package registry

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/storageregistry"
)

var (
	// ErrUnavailable means the bucket role is not configured or cannot be read.
	ErrUnavailable = errors.New("对象存储暂不可用")
	// ErrChecksum means the configured store does not sign checksums.
	ErrChecksum = errors.New("对象存储必须支持签名校验和")
	// ErrInput means the request is malformed.
	ErrInput = errors.New("上传请求无效")
)

// UploadTTL is how long a pending upload row stays valid.
const UploadTTL = 4 * time.Hour

// ConfirmTTL is the window in which a confirm may follow a PUT.
const ConfirmTTL = 4 * time.Hour

// Now is the injected clock.
type Now func() time.Time

// Service is presign and confirm.
type Service struct {
	Store   Store
	Signer  Signer
	Buckets Resolver
	Now     Now
}

// PresignRequest is one browser request. Purpose is resolved server-side; the
// client never sends a bucket, a path or a scope.
type PresignRequest struct {
	ActorID   int64
	OrgID     int64
	Purpose   contract.PurposeKind
	PurposeID string
	// BindingID is only read for delegate_binding.
	BindingID  string
	SHA256Hex  string
	ByteLength int64
	Extension  string
	// MultipartID is set when the browser started a multipart upload and the
	// server signed the completion. Empty means a single PUT.
	MultipartID string
}

// PresignResult is what the handler returns.
type PresignResult struct {
	UploadID    string
	ObjectID    string
	ObjectKey   string
	PublicURL   string
	Grant       *Grant
	ContentType string
	ExpiresAtMS int64
	Reuse       bool
	Bucket      contract.Role
}

// Presign resolves the purpose, checks the registry and either reuses a live
// object or inserts a pending upload row with a signed PUT.
func (s Service) Presign(ctx context.Context, req PresignRequest) (PresignResult, error) {
	if s.Store == nil || s.Signer == nil || s.Buckets == nil {
		return PresignResult{}, ErrUnavailable
	}
	purpose, err := contract.ResolvePurpose(string(req.Purpose), req.PurposeID, req.OrgID, req.BindingID)
	if err != nil {
		return PresignResult{}, ErrInput
	}
	if !contract.Registered(purpose.Bucket) {
		return PresignResult{}, ErrInput
	}
	digest, err := contract.SHA256Hex(req.SHA256Hex)
	if err != nil {
		return PresignResult{}, ErrInput
	}
	ext, err := contract.NormalizeExtension(req.Extension)
	if err != nil {
		return PresignResult{}, ErrInput
	}
	contentType, err := contract.ContentType(ext)
	if err != nil {
		return PresignResult{}, ErrInput
	}
	if req.ByteLength <= 0 {
		return PresignResult{}, ErrInput
	}
	account, err := s.Buckets.Bucket(ctx, purpose.Bucket)
	if err != nil {
		return PresignResult{}, ErrUnavailable
	}
	identity, err := account.config(purpose.Bucket).Identity()
	if err != nil {
		return PresignResult{}, ErrUnavailable
	}
	key, err := contract.ObjectKey(account.KeyPrefix, purpose, digest, ext)
	if err != nil {
		return PresignResult{}, ErrInput
	}
	claim := storageregistry.Claim{
		Bucket: string(purpose.Bucket), BucketIdentity: identity, ObjectKey: key, DedupeScope: purpose.Scope,
		SHA256Hex: digest, ByteLength: req.ByteLength, ContentType: contentType, Extension: string(ext),
	}
	byScope, byKey, err := s.Store.Lookup(ctx, claim)
	if err != nil {
		return PresignResult{}, ErrUnavailable
	}
	decision, object, err := storageregistry.DecidePresign(claim, byScope, byKey)
	if err != nil {
		return PresignResult{}, err
	}
	if decision == storageregistry.ReuseObject {
		return PresignResult{
			ObjectID: object.ID, ObjectKey: key, ContentType: contentType,
			PublicURL: contract.PublicURL(purpose.Bucket, key), Reuse: true, Bucket: purpose.Bucket,
		}, nil
	}
	now := s.clock()
	expires := now.Add(UploadTTL)
	grant, err := s.Signer.PresignPut(account, key, contentType, req.ByteLength, digest, now)
	if err != nil {
		return PresignResult{}, err
	}
	uploadID, err := s.Store.BeginUpload(ctx, UploadRow{
		ActorID: req.ActorID, OrgID: req.OrgID, PurposeKind: string(purpose.Kind), PurposeID: purpose.ID,
		Bucket: string(purpose.Bucket), BucketIdentity: identity, ObjectKey: key, DedupeScope: purpose.Scope,
		SHA256Hex: digest, ByteLength: req.ByteLength, ContentType: contentType,
		Extension: string(ext), MultipartID: req.MultipartID, State: storageregistry.UploadPending, ExpiresAt: expires,
	})
	if err != nil {
		return PresignResult{}, err
	}
	return PresignResult{
		UploadID: uploadID, ObjectKey: key, PublicURL: contract.PublicURL(purpose.Bucket, key),
		Grant: &grant, ContentType: contentType, ExpiresAtMS: grant.ExpiresAt.UnixMilli(),
		Bucket: purpose.Bucket,
	}, nil
}

// ConfirmRequest is the client's proof that the PUT finished.
type ConfirmRequest struct {
	ActorID  int64
	OrgID    int64
	UploadID string
}

// ConfirmHead reads the proof of one stored object. The handler supplies it:
// the service does not dial the bucket.
type ConfirmHead func(ctx context.Context, upload UploadRow) (Object, error)

// Confirm revalidates the lease, applies the proof and registers the object.
func (s Service) Confirm(ctx context.Context, req ConfirmRequest, head ConfirmHead) (PresignResult, error) {
	if s.Store == nil || head == nil {
		return PresignResult{}, ErrUnavailable
	}
	if strings.TrimSpace(req.UploadID) == "" {
		return PresignResult{}, ErrInput
	}
	upload, err := s.Store.Upload(ctx, req.UploadID, req.ActorID, req.OrgID)
	if err != nil {
		return PresignResult{}, err
	}
	now := s.clock()
	if upload.State != storageregistry.UploadPending {
		return PresignResult{}, storageregistry.ErrState
	}
	if !upload.ExpiresAt.After(now) {
		return PresignResult{}, storageregistry.ErrExpired
	}
	proven, err := head(ctx, upload)
	if err != nil {
		return PresignResult{}, err
	}
	if !proven.Exists {
		return PresignResult{}, storageregistry.ErrConflict
	}
	claim := storageregistry.Claim{
		Bucket: upload.Bucket, BucketIdentity: upload.BucketIdentity, ObjectKey: upload.ObjectKey,
		DedupeScope: upload.DedupeScope, SHA256Hex: upload.SHA256Hex, ByteLength: upload.ByteLength,
		ContentType: upload.ContentType, Extension: upload.Extension,
	}
	byScope, byKey, err := s.Store.Lookup(ctx, claim)
	if err != nil {
		return PresignResult{}, ErrUnavailable
	}
	existing := append(append([]storageregistry.Object{}, byScope...), byKey...)
	decision, err := storageregistry.DecideConfirm(storageregistry.ConfirmInput{
		Claim: claim, Now: now, ExpiresAt: upload.ExpiresAt,
		HeadLength: proven.ByteLength, HeadType: proven.ContentType, HeadSHA256Hex: proven.SHA256Hex,
	}, existing)
	if err != nil {
		return PresignResult{}, err
	}
	objectID, err := s.Store.Confirm(ctx, upload.ID, decision)
	if err != nil {
		return PresignResult{}, err
	}
	bucket := contract.Role(upload.Bucket)
	return PresignResult{
		UploadID: upload.ID, ObjectID: objectID, ObjectKey: upload.ObjectKey,
		ContentType: upload.ContentType, PublicURL: contract.PublicURL(bucket, upload.ObjectKey),
		Bucket: bucket, Reuse: decision.Reuse,
	}, nil
}

// DownloadGrant signs a short-lived GET for a private object. The caller has
// already checked visibility; this method only signs.
func (s Service) DownloadGrant(ctx context.Context, bucket contract.Role, key, filename, contentType string, ttl time.Duration) (string, error) {
	if s.Signer == nil || s.Buckets == nil {
		return "", ErrUnavailable
	}
	if bucket != contract.RolePrivate {
		return contract.PublicURL(bucket, key), nil
	}
	account, err := s.Buckets.Bucket(ctx, bucket)
	if err != nil {
		return "", ErrUnavailable
	}
	if ttl < 60*time.Second {
		ttl = 60 * time.Second
	}
	if ttl > 300*time.Second {
		ttl = 300 * time.Second
	}
	return s.Signer.PresignGet(account, key, s.clock(), ttl, filename, contentType)
}

// WithClock returns the same service with an injected clock. The handler
// passes the server clock so presign and confirm share one time source; a nil
// clock keeps the real one.
func (s Service) WithClock(now Now) Service {
	if now != nil {
		s.Now = now
	}
	return s
}

func (s Service) clock() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
