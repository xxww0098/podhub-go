// Package receipt is the upload-intent ticket from src/media/upload_receipt.rs.
//
// The payload is serde_json field order, HMAC-SHA256 under the account secret
// with the domain separator podhub/storage-upload-intent/v1. Confirm compares
// this ticket; it is not a second object store.
package receipt

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const (
	ttl         = 4 * time.Hour
	maxTokenLen = 16 * 1024
	domain      = "podhub/storage-upload-intent/v1\x00"
)

// ErrInvalid is the Rust validation message for a bad or expired ticket.
var ErrInvalid = errors.New("上传凭据无效或已过期，请重新选择文件")

// ErrUnavailable is returned when the account secret cannot sign.
var ErrUnavailable = errors.New("对象存储确认暂不可用，请稍后重试确认")

// Subject binds a ticket to one actor and purpose.
type Subject struct {
	Purpose     string
	ActorID     int64
	WorkspaceID *int64
}

// Object is the single object the ticket authorises.
type Object struct {
	Key         string
	ContentType string
	ByteLength  uint64
	SHA256      string
}

// Receipt is the signed JSON body. False and empty optional fields are omitted,
// matching serde skip_serializing_if.
type Receipt struct {
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

// Target is a ticket plus the optional single-PUT grant.
type Target struct {
	Grant   *sign.Grant
	Ticket  string
	Receipt Receipt
}

// StorageIdentity is sha256 of the serde_json array Rust hashes.
// Provider strings are the snake_case enum names.
func StorageIdentity(account sign.Account) string {
	payload, err := marshal([]any{
		account.ID,
		string(account.Provider),
		strings.TrimSpace(account.Endpoint),
		strings.TrimSpace(account.Region),
		strings.TrimSpace(account.Bucket),
		account.KeyPrefix,
		account.ForcePathStyle,
	})
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// Issue signs a single-PUT ticket and the matching browser grant.
func Issue(account sign.Account, subject Subject, object Object, now time.Time, enforceChecksum bool, putExpires *time.Time) (Target, error) {
	if !validObject(object) || !validSubject(subject) {
		return Target{}, ErrInvalid
	}
	enforce := enforceChecksum && sign.AcceptsStoreChecksum(account)
	body := Receipt{
		Purpose:          subject.Purpose,
		ActorID:          subject.ActorID,
		WorkspaceID:      subject.WorkspaceID,
		Key:              object.Key,
		ContentType:      object.ContentType,
		ByteLength:       object.ByteLength,
		SHA256:           object.SHA256,
		StorageIdentity:  StorageIdentity(account),
		IssuedAtMS:       now.UTC().UnixMilli(),
		ExpiresAtMS:      now.UTC().UnixMilli() + ttl.Milliseconds(),
		ChecksumEnforced: enforce,
	}
	var checksum string
	if enforce {
		checksum = object.SHA256
	}
	grant, err := sign.SignPut(account, object.Key, object.ContentType, object.ByteLength, now, checksum, putExpires)
	if err != nil {
		return Target{}, err
	}
	ticket, err := seal(account, body)
	if err != nil {
		return Target{}, err
	}
	return Target{Grant: &grant, Ticket: ticket, Receipt: body}, nil
}

// Verify checks the HMAC, the subject, and the four-hour lifetime.
func Verify(account sign.Account, token string, subject Subject, now time.Time) (Receipt, error) {
	if len(token) > maxTokenLen {
		return Receipt{}, ErrInvalid
	}
	payload, signature, ok := strings.Cut(token, ".")
	if !ok {
		return Receipt{}, ErrInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return Receipt{}, ErrInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return Receipt{}, ErrInvalid
	}
	mac, err := signer(account)
	if err != nil {
		return Receipt{}, err
	}
	_, _ = mac.Write(raw)
	if !hmac.Equal(mac.Sum(nil), sig) {
		return Receipt{}, ErrInvalid
	}
	var body Receipt
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		return Receipt{}, ErrInvalid
	}
	object := Object{Key: body.Key, ContentType: body.ContentType, ByteLength: body.ByteLength, SHA256: body.SHA256}
	if !validObject(object) || body.Purpose != subject.Purpose || body.ActorID != subject.ActorID || !sameWorkspace(body.WorkspaceID, subject.WorkspaceID) || body.StorageIdentity != StorageIdentity(account) {
		return Receipt{}, ErrInvalid
	}
	issued := body.IssuedAtMS
	expires := body.ExpiresAtMS
	if issued > now.UTC().UnixMilli()+5000 || expires <= now.UTC().UnixMilli() || expires-issued != ttl.Milliseconds() {
		return Receipt{}, ErrInvalid
	}
	if (body.PartSize != 0 && body.MultipartUploadID == "") || (body.MultipartUploadID != "" && body.PartSize == 0) {
		return Receipt{}, ErrInvalid
	}
	if body.PartSize != 0 && body.PartSize != 16*1024*1024 {
		return Receipt{}, ErrInvalid
	}
	return body, nil
}

func seal(account sign.Account, body Receipt) (string, error) {
	payload, err := marshal(body)
	if err != nil {
		return "", ErrUnavailable
	}
	mac, err := signer(account)
	if err != nil {
		return "", err
	}
	_, _ = mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func signer(account sign.Account) (hash, error) {
	secret := strings.TrimSpace(account.SecretAccessKey)
	if secret == "" {
		return nil, ErrUnavailable
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(domain))
	return mac, nil
}

type hash interface {
	Write([]byte) (int, error)
	Sum([]byte) []byte
}

func marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func validSubject(subject Subject) bool {
	return subject.Purpose != "" && len(subject.Purpose) <= 512 && subject.ActorID > 0
}

func validObject(object Object) bool {
	if object.ByteLength == 0 || object.ByteLength > sign.MaxObjectBytes {
		return false
	}
	if object.Key == "" || len(object.Key) > 2048 || bad(object.Key) {
		return false
	}
	if object.ContentType == "" || len(object.ContentType) > 128 || bad(object.ContentType) {
		return false
	}
	if len(object.SHA256) != 64 {
		return false
	}
	for i := 0; i < len(object.SHA256); i++ {
		c := object.SHA256[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func bad(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 32 || value[i] == 127 {
			return true
		}
	}
	return false
}

func sameWorkspace(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
