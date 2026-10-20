// Package storageregistry is the state machine for storage_objects and
// storage_uploads from docs/architecture/storage-common.md.
//
// It decides whether a presign target already exists, what confirm writes,
// what the collector may delete, and when a tombstone blocks a key. Every
// function is pure: rows in, decision out. The repository is what holds the
// advisory fence and the transaction.
package storageregistry

import (
	"errors"
	"strings"
	"time"
)

var (
	// ErrConflict means the requested target contradicts a stored row.
	ErrConflict = errors.New("对象与已注册内容冲突")
	// ErrNotLive means the row is deleting or deleted.
	ErrNotLive = errors.New("对象已进入回收，不能复用")
	// ErrExpired means the upload lease ran out.
	ErrExpired = errors.New("上传会话已过期，请重新选择文件")
	// ErrState means the upload row is not pending.
	ErrState = errors.New("上传会话状态不允许该操作")
	// ErrReferenced means a live reference still holds the object.
	ErrReferenced = errors.New("对象仍被业务记录引用")
)

// State is one registry row state.
type State string

const (
	StateLive     State = "live"
	StateDeleting State = "deleting"
	StateDeleted  State = "deleted"
)

// UploadState is one upload row state.
type UploadState string

const (
	UploadPending   UploadState = "pending"
	UploadConfirmed UploadState = "confirmed"
	UploadExpired   UploadState = "expired"
	UploadAborted   UploadState = "aborted"
	// UploadSuperseded is a dead row whose key slot a new lease took over.
	UploadSuperseded UploadState = "superseded"
)

// Object is the registry row a decision reads.
type Object struct {
	ID             string
	Bucket         string
	BucketIdentity string
	ObjectKey      string
	DedupeScope    string
	SHA256Hex      string
	ByteLength     int64
	ContentType    string
	Extension      string
	State          State
}

// Claim is the requested target: one bucket, one key, one digest.
type Claim struct {
	// Bucket is the registry bucket name ("assets" or "private").
	Bucket         string
	BucketIdentity string
	ObjectKey      string
	DedupeScope    string
	SHA256Hex      string
	ByteLength     int64
	ContentType    string
	Extension      string
}

// SameKey reports whether an existing row is the exact object the claim asks
// for. Size, type and scope must match too: the key alone is not proof.
func (o Object) SameKey(claim Claim) bool {
	return o.BucketIdentity == claim.BucketIdentity &&
		o.ObjectKey == claim.ObjectKey &&
		o.DedupeScope == claim.DedupeScope &&
		strings.EqualFold(o.SHA256Hex, claim.SHA256Hex) &&
		o.ByteLength == claim.ByteLength &&
		o.ContentType == claim.ContentType &&
		o.Extension == claim.Extension
}

// PresignDecision is what the presign handler should return.
type PresignDecision int

const (
	// UploadNeeded means no live object exists; insert a pending upload row.
	UploadNeeded PresignDecision = iota
	// ReuseObject means a live row already holds this exact content.
	ReuseObject
)

// DecidePresign compares the claim with the rows the repository found for the
// same (bucket_identity, dedupe_scope, sha256, extension). An empty result
// means a normal upload. A live row with the same key is a reuse; a live row
// with a different key means the dedupe scope was reused inconsistently and
// the claim is refused. A tombstone never authorises the key again.
func DecidePresign(claim Claim, byScope []Object, byKey []Object) (PresignDecision, Object, error) {
	for _, row := range byScope {
		switch row.State {
		case StateLive:
			if !row.SameKey(claim) {
				return UploadNeeded, Object{}, ErrConflict
			}
			return ReuseObject, row, nil
		case StateDeleting:
			return UploadNeeded, Object{}, ErrNotLive
		case StateDeleted:
			// A tombstoned key cannot be revived by a new upload with the
			// same digest; the content-addressed key is retired for good.
			if row.ObjectKey == claim.ObjectKey {
				return UploadNeeded, Object{}, ErrNotLive
			}
		}
	}
	for _, row := range byKey {
		switch row.State {
		case StateLive:
			if !row.SameKey(claim) {
				return UploadNeeded, Object{}, ErrConflict
			}
			return ReuseObject, row, nil
		case StateDeleting:
			return UploadNeeded, Object{}, ErrNotLive
		case StateDeleted:
			return UploadNeeded, Object{}, ErrNotLive
		}
	}
	return UploadNeeded, Object{}, nil
}

// ConfirmInput is what the HEAD proof produced plus the claim it proves.
type ConfirmInput struct {
	Claim      Claim
	Now        time.Time
	ExpiresAt  time.Time
	HeadLength int64
	HeadType   string
	// HeadSHA256Hex is the full-object checksum the store echoed. It is empty
	// when the store did not return one; confirm then refuses.
	HeadSHA256Hex string
}

// ConfirmDecision is what confirm writes.
type ConfirmDecision struct {
	Reuse     bool
	ObjectID  string
	Claim     Claim
	RetireKey string
}

// DecideConfirm validates the HEAD proof and the lease. It does not write.
// A store that cannot echo a full-object checksum cannot confirm a long-lived
// object: there is no body read fallback.
func DecideConfirm(in ConfirmInput, existing []Object) (ConfirmDecision, error) {
	if !in.ExpiresAt.After(in.Now) {
		return ConfirmDecision{}, ErrExpired
	}
	if in.HeadSHA256Hex == "" || !strings.EqualFold(in.HeadSHA256Hex, in.Claim.SHA256Hex) {
		return ConfirmDecision{}, ErrConflict
	}
	if in.HeadLength != in.Claim.ByteLength {
		return ConfirmDecision{}, ErrConflict
	}
	if normalizeType(in.HeadType) != in.Claim.ContentType {
		return ConfirmDecision{}, ErrConflict
	}
	for _, row := range existing {
		switch row.State {
		case StateLive:
			if !row.SameKey(in.Claim) {
				return ConfirmDecision{}, ErrConflict
			}
			return ConfirmDecision{Reuse: true, ObjectID: row.ID, Claim: in.Claim}, nil
		case StateDeleting, StateDeleted:
			return ConfirmDecision{}, ErrNotLive
		}
	}
	return ConfirmDecision{Reuse: false, Claim: in.Claim}, nil
}

// normalizeType drops parameters and case from a Content-Type header.
func normalizeType(raw string) string {
	if i := strings.IndexByte(raw, ';'); i >= 0 {
		raw = raw[:i]
	}
	return strings.ToLower(strings.TrimSpace(raw))
}

// Upload is one storage_uploads row. It lives here so the service port and
// the pgx repository can share it without importing each other.
type Upload struct {
	ID             string
	ActorID        int64
	OrgID          int64
	PurposeKind    string
	PurposeID      string
	Bucket         string
	BucketIdentity string
	ObjectKey      string
	DedupeScope    string
	SHA256Hex      string
	ByteLength     int64
	ContentType    string
	Extension      string
	MultipartID    string
	State          UploadState
	ExpiresAt      time.Time
}

// UploadLease is the pending row the collector reads.
type UploadLease struct {
	ID          string
	ObjectKey   string
	State       UploadState
	ExpiresAt   time.Time
	MultipartID string
}

// Expired reports whether a pending row may be reclaimed at now.
func (u UploadLease) Expired(now time.Time) bool {
	return u.State == UploadPending && !u.ExpiresAt.After(now)
}

// CollectDecision is what the expired-upload collector does with one key.
type CollectDecision int

const (
	// CollectSkip means another live object or another pending lease exists.
	CollectSkip CollectDecision = iota
	// CollectAbort means the multipart upload must be aborted before cleanup.
	CollectAbort
	// CollectDelete means the key has no owner and may be deleted.
	CollectDelete
)

// ExpiryLease records what the key still holds. ObjectExists is true when a
// storage_objects row (any live state) names the key. PendingOthers counts
// unexpired pending rows for the same key, including the row being handled.
type ExpiryLease struct {
	ObjectExists  bool
	PendingOthers int
	MultipartID   string
}

// DecideCollect applies the per-key rule: an object row wins over the upload
// lease, and another unexpired pending row keeps the key alive.
func DecideCollect(lease UploadLease, now time.Time, key ExpiryLease) CollectDecision {
	if !lease.Expired(now) {
		return CollectSkip
	}
	if key.ObjectExists || key.PendingOthers > 1 {
		return CollectSkip
	}
	if key.MultipartID != "" {
		return CollectAbort
	}
	return CollectDelete
}

// ReferenceCheck is the collector's last step before removing bytes.
type ReferenceCheck struct {
	// Referenced is the result of SELECT EXISTS(... storage_object_refs ...).
	Referenced bool
	// Locked is false when the exclusive fence could not be taken.
	Locked bool
}

// DecideRetire says whether the collector may delete the stored bytes.
func DecideRetire(check ReferenceCheck) error {
	if !check.Locked {
		return ErrConflict
	}
	if check.Referenced {
		return ErrReferenced
	}
	return nil
}
