package domain

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

const (
	receiptTTL = 4 * time.Hour
	ticketSep  = "podhub/storage-upload-intent/v1\x00"
	promoSep   = "podhub/admin-upload-promotion/v1\x00"
)

// UploadReceipt is the signed ticket body. False and empty options are omitted.
type UploadReceipt struct {
	Purpose           string `json:"purpose"`
	ActorID           int64  `json:"actor_id"`
	WorkspaceID       *int64 `json:"workspace_id"`
	Key               string `json:"key"`
	ContentType       string `json:"content_type"`
	ByteLength        uint64 `json:"byte_length"`
	SHA256            string `json:"sha256"`
	StorageIdentity   string `json:"storage_identity"`
	IssuedAtMS        int64  `json:"issued_at_ms"`
	ExpiresAtMS       int64  `json:"expires_at_ms"`
	ChecksumEnforced  bool   `json:"checksum_enforced,omitempty"`
	MultipartUploadID string `json:"multipart_upload_id,omitempty"`
	PartSize          uint64 `json:"part_size,omitempty"`
	NoBodyRead        bool   `json:"no_body_read,omitempty"`
}

// IssuedUpload is a ticket plus the browser PUT grant. Grant is nil for multipart.
type IssuedUpload struct {
	Grant   *sign.Grant
	Ticket  string
	Receipt UploadReceipt
}

// StorageIdentity hashes the account the way the receipt seals it.
func StorageIdentity(account sign.Account) string {
	raw, err := compactJSON([]any{
		account.ID, string(account.Provider), strings.TrimSpace(account.Endpoint),
		strings.TrimSpace(account.Region), strings.TrimSpace(account.Bucket),
		account.KeyPrefix, account.ForcePathStyle,
	})
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// IssueUpload signs a single-PUT ticket and grant.
func IssueUpload(account sign.Account, purpose string, actor int64, objectKey, contentType, sha string, bytes uint64, now time.Time, enforce bool) (IssuedUpload, error) {
	body := UploadReceipt{
		Purpose: purpose, ActorID: actor, Key: objectKey, ContentType: contentType,
		ByteLength: bytes, SHA256: sha, StorageIdentity: StorageIdentity(account),
		IssuedAtMS: now.UTC().UnixMilli(), ExpiresAtMS: now.UTC().UnixMilli() + receiptTTL.Milliseconds(),
		ChecksumEnforced: enforce && sign.AcceptsStoreChecksum(account),
	}
	var checksum string
	if body.ChecksumEnforced {
		checksum = sha
	}
	grant, err := sign.SignPut(account, objectKey, contentType, bytes, now, checksum, nil)
	if err != nil {
		return IssuedUpload{}, fail(contract.KindValidation, err.Error())
	}
	ticket, err := sealTicket(account, body)
	if err != nil {
		return IssuedUpload{}, fail(contract.KindInternal, "服务暂不可用")
	}
	return IssuedUpload{Grant: &grant, Ticket: ticket, Receipt: body}, nil
}

// IssueMultipart signs a ticket with no PUT grant. The caller sets the upload id
// and part size; the returned ticket is also the multipart ticket.
func IssueMultipart(account sign.Account, purpose string, actor int64, objectKey, contentType, sha, uploadID string, bytes, partSize uint64, now time.Time) (IssuedUpload, error) {
	body := UploadReceipt{
		Purpose: purpose, ActorID: actor, Key: objectKey, ContentType: contentType,
		ByteLength: bytes, SHA256: sha, StorageIdentity: StorageIdentity(account),
		IssuedAtMS: now.UTC().UnixMilli(), ExpiresAtMS: now.UTC().UnixMilli() + receiptTTL.Milliseconds(),
		MultipartUploadID: uploadID, PartSize: partSize,
	}
	ticket, err := sealTicket(account, body)
	if err != nil {
		return IssuedUpload{}, fail(contract.KindInternal, "服务暂不可用")
	}
	return IssuedUpload{Ticket: ticket, Receipt: body}, nil
}

// OpenTicket checks the HMAC, purpose, actor, and four-hour lifetime.
func OpenTicket(account sign.Account, token, purpose string, actor int64, now time.Time) (UploadReceipt, error) {
	body, err := OpenSealed(account, token, actor, now)
	if err != nil {
		return UploadReceipt{}, err
	}
	if body.Purpose != purpose {
		return UploadReceipt{}, fail(contract.KindValidation, "上传凭据无效或已过期，请重新选择文件")
	}
	return body, nil
}

// OpenSealed checks the HMAC, actor, and lifetime without comparing purpose.
// The caller matches purpose to the object key it already derived.
func OpenSealed(account sign.Account, token string, actor int64, now time.Time) (UploadReceipt, error) {
	bad := fail(contract.KindValidation, "上传凭据无效或已过期，请重新选择文件")
	if len(token) > 16*1024 {
		return UploadReceipt{}, bad
	}
	payload, signature, ok := strings.Cut(token, ".")
	if !ok {
		return UploadReceipt{}, bad
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return UploadReceipt{}, bad
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return UploadReceipt{}, bad
	}
	mac := hmac.New(sha256.New, []byte(strings.TrimSpace(account.SecretAccessKey)))
	_, _ = mac.Write([]byte(ticketSep))
	_, _ = mac.Write(raw)
	if !hmac.Equal(mac.Sum(nil), sig) {
		return UploadReceipt{}, bad
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body UploadReceipt
	if err := dec.Decode(&body); err != nil {
		return UploadReceipt{}, bad
	}
	if body.ActorID != actor || body.WorkspaceID != nil || body.StorageIdentity != StorageIdentity(account) {
		return UploadReceipt{}, bad
	}
	if body.IssuedAtMS > now.UTC().UnixMilli()+5000 || body.ExpiresAtMS <= now.UTC().UnixMilli() || body.ExpiresAtMS-body.IssuedAtMS != receiptTTL.Milliseconds() {
		return UploadReceipt{}, bad
	}
	return body, nil
}

// PromotionMarker is the HMAC written as x-amz-meta-podhub-upload.
// The encoding is lowercase hex. The spec names HMAC-SHA256 and the JSON array
// but not the encoding; hex is what this port emits.
func PromotionMarker(secret string, identity, stage, dest, sha, contentType string, length uint64) string {
	raw, _ := compactJSON([]any{identity, stage, dest, sha, length, contentType})
	mac := hmac.New(sha256.New, []byte(strings.TrimSpace(secret)))
	_, _ = mac.Write([]byte(promoSep))
	_, _ = mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}

func sealTicket(account sign.Account, body UploadReceipt) (string, error) {
	payload, err := compactJSON(body)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, []byte(strings.TrimSpace(account.SecretAccessKey)))
	_, _ = mac.Write([]byte(ticketSep))
	_, _ = mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func compactJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// PurposeForKey is admin-supplier-upload: plus the hex sha256 of the final key.
func PurposeForKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "admin-supplier-upload:" + hex.EncodeToString(sum[:])
}
