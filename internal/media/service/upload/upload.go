// Package upload builds the presign result Cloud would hand the browser:
// object key, public URL, signed PUT, and upload ticket.
//
// POST /api/media/objects/{digest}/{extension}/presign calls Presign after
// the session org is known. Other media HTTP routes stay unwired.
package upload

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// Limits for the R2 upload path. sign.MaxObjectBytes remains
// the single-PUT ceiling Rust's sign_put enforces.
const (
	MaxPSDBytes         uint64 = 500 * 1024 * 1024
	MaxDelegateOriginal uint64 = 500 * 1024 * 1024
	MaxSupplierVideo    uint64 = 200 * 1024 * 1024
	MaxGalleryBytes     uint64 = 20 * 1024 * 1024
)

// Request is one presign input. Batch empty means a legacy class key.
// Batch set means compose_batched_key; the batch string is "{millis}.{uuid}".
type Request struct {
	Account     sign.Account
	Prefix      string
	Workspace   string
	Digest      string
	Ext         string
	Batch       string
	ByteLength  uint64
	Now         time.Time
	Purpose     string
	ActorID     int64
	WorkspaceID *int64
	ExpiresAt   *time.Time
}

// Response is the comparable presign result. JSON field order is fixed.
type Response struct {
	ObjectKey      string `json:"object_key"`
	PublicURL      string `json:"public_url"`
	URL            string `json:"url"`
	ContentType    string `json:"content_type"`
	IfNoneMatch    string `json:"if_none_match"`
	ChecksumSHA256 string `json:"checksum_sha256,omitempty"`
	ExpiresAtMS    int64  `json:"expires_at_ms"`
	UploadTicket   string `json:"upload_ticket"`
	Canonical      string `json:"-"`
}

// Presign composes the key, signs the PUT, and issues the ticket.
func Presign(req Request) (Response, error) {
	ext, err := objectkey.NormalizeExt(req.Ext)
	if err != nil {
		return Response{}, err
	}
	var key string
	if req.Batch != "" {
		key, err = objectkey.ComposeBatchedKey(req.Prefix, req.Workspace, req.Digest, ext, req.Batch)
	} else {
		class := objectkey.ClassImage
		if ext == "mp4" || ext == "mov" {
			class = objectkey.ClassVideo
		}
		key, err = objectkey.ComposeKey(req.Prefix, class, req.Workspace, req.Digest, ext)
	}
	if err != nil {
		return Response{}, err
	}
	contentType, err := objectkey.ContentType(ext)
	if err != nil {
		return Response{}, err
	}
	ref, ok := objectkey.ParseRef(key)
	if !ok {
		return Response{}, objectkey.ErrDigest
	}
	purpose := req.Purpose
	if purpose == "" {
		purpose = "workflow-media"
	}
	// The checksum is not a switch: a store that cannot sign it is refused by
	// receipt.Issue and the caller surfaces the error.
	target, err := receipt.Issue(req.Account, receipt.Subject{
		Purpose: purpose, ActorID: req.ActorID, WorkspaceID: req.WorkspaceID,
	}, receipt.Object{
		Key: key, ContentType: contentType, ByteLength: req.ByteLength, SHA256: ref.Digest,
	}, req.Now, true, req.ExpiresAt)
	if err != nil {
		return Response{}, err
	}
	return Response{
		ObjectKey:      key,
		PublicURL:      sign.PublicURL(req.Account, key),
		URL:            target.Grant.URL,
		ContentType:    target.Grant.ContentType,
		IfNoneMatch:    target.Grant.IfNoneMatch,
		ChecksumSHA256: target.Grant.ChecksumSHA256,
		ExpiresAtMS:    target.Grant.ExpiresAt.UnixMilli(),
		UploadTicket:   target.Ticket,
		Canonical:      target.Grant.Canonical,
	}, nil
}
