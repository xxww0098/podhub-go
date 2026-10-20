// Package objectkey is the media-core object-key algebra from a03d735.
//
// The stored shape is {prefix}{class}/teams/{workspace}/sha256/{digest}.{ext}.
// Composition and parsing do no I/O. Cloud and the browser agree on this
// string; a second implementation that drifts is not noticed until a picture
// is already gone.
package objectkey

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	// RetentionHours is the image transit window.
	RetentionHours int64 = 4
	// UploadBatchHours is how long a server-issued upload directory stays valid.
	UploadBatchHours int64 = 4
	// RetentionDays is the R2 lifecycle on {prefix}uploads/.
	RetentionDays uint32 = 30
	// SubmitMaxAgeDays is two days inside RetentionDays.
	SubmitMaxAgeDays uint32 = RetentionDays - 2
)

// Class is the key segment images or videos.
type Class int

const (
	ClassImage Class = iota
	ClassVideo
)

// Segment is the path piece compose writes.
func (c Class) Segment() string {
	if c == ClassVideo {
		return "videos"
	}
	return "images"
}

// Error is why a string is not a media object key. The text matches
// media-core's MediaObjectError Display.
type Error string

func (e Error) Error() string { return string(e) }

const (
	ErrWorkspace Error = "workspace uuid is not a hyphenated v4 uuid"
	ErrDigest    Error = "content digest is not 64 hex characters"
	ErrExt       Error = "media extension is not one the origin stores"
	ErrPrefix    Error = "object key prefix is not a plain relative path"
)

// Ref is a key or public URL after the trust-boundary parse.
type Ref struct {
	Class     Class
	Workspace string
	Digest    string
}

// UploadKey is the canonical batch shape compose emits.
type UploadKey struct {
	Workspace string
	BatchMS   int64
	BatchID   string
	Digest    string
	Ext       string
}

// healthcheckPNG is the 1x1 probe the browser uploads. Cloud recognises it
// by digest so a connectivity check is not metered and not collected as media.
var healthcheckPNG = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 'I', 'D', 'A', 'T', 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
	0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 'I', 'E',
	'N', 'D', 0xae, 0x42, 0x60, 0x82,
}

// HealthcheckDigest is SHA-256 of healthcheckPNG, lowercase hex.
func HealthcheckDigest() string {
	sum := sha256.Sum256(healthcheckPNG)
	return hex.EncodeToString(sum[:])
}

// IsHealthcheckDigest reports the connectivity-probe digest.
func IsHealthcheckDigest(digest string) bool {
	return strings.EqualFold(digest, HealthcheckDigest())
}

// ComposeKey builds {prefix}{class}/teams/{workspace}/sha256/{digest}.{ext}.
func ComposeKey(prefix string, class Class, workspace, digest, ext string) (string, error) {
	workspace, err := NormalizeWorkspace(workspace)
	if err != nil {
		return "", err
	}
	digest, err = normalizeDigestLower(digest)
	if err != nil {
		return "", err
	}
	ext, err = NormalizeExt(ext)
	if err != nil {
		return "", err
	}
	if !accepts(class, ext) {
		return "", ErrExt
	}
	prefix, err = NormalizePrefix(prefix)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%s/teams/%s/sha256/%s.%s", prefix, class.Segment(), workspace, digest, ext), nil
}

// ComposeBatchedKey builds an image key inside a server-issued upload directory.
// batch is "{unixMillis}.{uuid}". The path joins those fields with a hyphen,
// which is what parse_upload_key reads back (compose.rs splitn on '.').
func ComposeBatchedKey(prefix, workspace, digest, ext, batch string) (string, error) {
	workspace, err := NormalizeWorkspace(workspace)
	if err != nil {
		return "", err
	}
	digest, err = normalizeDigestLower(digest)
	if err != nil {
		return "", err
	}
	ext, err = NormalizeExt(ext)
	if err != nil {
		return "", err
	}
	if !accepts(ClassImage, ext) {
		return "", ErrExt
	}
	prefix, err = NormalizePrefix(prefix)
	if err != nil {
		return "", err
	}
	timestamp, batchUUID, ok := splitDottedBatch(batch)
	if !ok {
		return "", ErrPrefix
	}
	ms, err := parseMillis(timestamp)
	if err != nil {
		return "", ErrPrefix
	}
	date := time.UnixMilli(ms).UTC().Format("2006-01-02")
	return fmt.Sprintf("%suploads/%s/%s-%s/images/teams/%s/sha256/%s.%s",
		prefix, date, timestamp, batchUUID, workspace, digest, ext), nil
}

// splitDottedBatch matches compose_batched_key: splitn(3, '.'), then the
// first two fields. A third field is ignored, same as stopping after two next() calls.
func splitDottedBatch(batch string) (timestamp, id string, ok bool) {
	fields := strings.SplitN(batch, ".", 3)
	if len(fields) < 2 {
		return "", "", false
	}
	timestamp, id = fields[0], fields[1]
	if len(timestamp) < 13 || !allDigits(timestamp) || len(id) != 36 {
		return "", "", false
	}
	if _, err := uuid.Parse(id); err != nil {
		return "", "", false
	}
	return timestamp, id, true
}

func accepts(class Class, ext string) bool {
	switch class {
	case ClassImage:
		return ext == "jpg" || ext == "png"
	case ClassVideo:
		return ext == "mp4" || ext == "mov"
	default:
		return false
	}
}

// NormalizeWorkspace accepts a hyphenated UUID whose version nibble is 4.
// media-core checks bytes[14] == '4' and does not check the variant nibble.
func NormalizeWorkspace(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if !isUUIDv4(trimmed) {
		return "", ErrWorkspace
	}
	return strings.ToLower(trimmed), nil
}

// NormalizeExt folds jpeg onto jpg and returns one of jpg, png, mp4, mov.
func NormalizeExt(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "jpg", "jpeg":
		return "jpg", nil
	case "png":
		return "png", nil
	case "mp4":
		return "mp4", nil
	case "mov":
		return "mov", nil
	default:
		return "", ErrExt
	}
}

// NormalizePrefix returns "" or "a/b/". Backslash, empty segments, "." and ".." are refused.
func NormalizePrefix(value string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(value), "/")
	if trimmed == "" {
		return "", nil
	}
	if strings.Contains(trimmed, `\`) {
		return "", ErrPrefix
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", ErrPrefix
		}
	}
	return trimmed + "/", nil
}

// ContentType is the signed PUT type for a stored extension.
// jpg, png and mp4 are the types the checksum probes use. mov is video/quicktime.
func ContentType(ext string) (string, error) {
	folded, err := NormalizeExt(ext)
	if err != nil {
		return "", err
	}
	switch folded {
	case "jpg":
		return "image/jpeg", nil
	case "png":
		return "image/png", nil
	case "mp4":
		return "video/mp4", nil
	case "mov":
		return "video/quicktime", nil
	default:
		return "", ErrExt
	}
}

// BatchIdentity returns the {timestamp}-{uuid} directory of a batched key.
func BatchIdentity(key string) string {
	parts, ok := batchParts(key)
	if !ok {
		return ""
	}
	date, batch, class := parts[0], parts[1], parts[2]
	if _, err := time.Parse("2006-01-02", date); err != nil || class != "images" || !strings.Contains(batch, "-") {
		return ""
	}
	if parts[3] != "teams" || !isUUIDv4(parts[4]) || parts[5] != "sha256" {
		return ""
	}
	digest, ext, ok := splitFile(parts[6])
	if !ok || !isDigest(digest) || !isStoredExt(ext) {
		return ""
	}
	timestamp, batchUUID, ok := strings.Cut(batch, "-")
	if !ok || len(timestamp) < 13 || !allDigits(timestamp) {
		return ""
	}
	if _, err := uuid.Parse(batchUUID); err != nil {
		return ""
	}
	if !dateMatches(timestamp, date) {
		return ""
	}
	return batch
}

// BatchExpiresAt is the batch timestamp plus UploadBatchHours.
func BatchExpiresAt(key string) (time.Time, bool) {
	batch := BatchIdentity(key)
	if batch == "" {
		return time.Time{}, false
	}
	timestamp, _, ok := strings.Cut(batch, "-")
	if !ok {
		return time.Time{}, false
	}
	ms, err := parseMillis(timestamp)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(ms).UTC().Add(time.Duration(UploadBatchHours) * time.Hour), true
}

// ParseUploadKey reads the canonical batch shape and nothing else.
func ParseUploadKey(key string) (UploadKey, bool) {
	if hasDotSegment(key) {
		return UploadKey{}, false
	}
	parts, ok := batchParts(key)
	if !ok {
		return UploadKey{}, false
	}
	date, batch, class := parts[0], parts[1], parts[2]
	teams, workspace, shaSeg, file := parts[3], parts[4], parts[5], parts[6]
	if class != "images" || teams != "teams" || shaSeg != "sha256" || !isUUIDv4(workspace) {
		return UploadKey{}, false
	}
	digest, ext, ok := splitFile(file)
	if !ok || (ext != "jpg" && ext != "png") || !isDigest(digest) {
		return UploadKey{}, false
	}
	timestamp, batchUUID, ok := strings.Cut(batch, "-")
	if !ok || len(timestamp) < 13 || !allDigits(timestamp) {
		return UploadKey{}, false
	}
	ms, err := parseMillis(timestamp)
	if err != nil {
		return UploadKey{}, false
	}
	if _, err := uuid.Parse(batchUUID); err != nil {
		return UploadKey{}, false
	}
	if !dateMatches(timestamp, date) {
		return UploadKey{}, false
	}
	return UploadKey{
		Workspace: workspace,
		BatchMS:   ms,
		BatchID:   batchUUID,
		Digest:    digest,
		Ext:       ext,
	}, true
}

// ParseRef reads a bare key or a public URL.
func ParseRef(value string) (Ref, bool) {
	digest, ok := DigestFromKey(value)
	if !ok {
		return Ref{}, false
	}
	lowered := strings.ToLower(value)
	if hasDotSegment(lowered) {
		return Ref{}, false
	}
	needle := "/sha256/" + digest + "."
	idx := strings.LastIndex(lowered, needle)
	if idx < 0 {
		return Ref{}, false
	}
	head := lowered[:idx]
	tail := lowered[idx+len(needle):]
	if !isStoredExt(tail) {
		return Ref{}, false
	}
	parents, workspace, ok := splitParent(head)
	if !ok || !isUUIDv4(workspace) {
		return Ref{}, false
	}
	class, ok := classFromParent(parents, tail)
	if !ok {
		return Ref{}, false
	}
	return Ref{Class: class, Workspace: workspace, Digest: digest}, true
}

// EncodeObjectPath percent-encodes each segment and keeps '/'.
func EncodeObjectPath(value string) string {
	parts := strings.Split(value, "/")
	for i, part := range parts {
		parts[i] = EncodePathSegment(part)
	}
	return strings.Join(parts, "/")
}

// EncodePathSegment percent-encodes one segment. '/' is escaped here.
func EncodePathSegment(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if isUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// DigestFromKey is the hex digest a name ends with, when the extension is stored.
func DigestFromKey(key string) (string, bool) {
	file := key
	if i := strings.LastIndex(key, "/"); i >= 0 {
		file = key[i+1:]
	}
	digest, ext, ok := splitFile(file)
	if !ok || !isDigest(digest) || !isStoredExt(strings.ToLower(ext)) {
		return "", false
	}
	return strings.ToLower(digest), true
}

// KeyMatches reports that the parsed key is this workspace and these bytes.
func KeyMatches(key, workspace, digest string) bool {
	workspace, err := NormalizeWorkspace(workspace)
	if err != nil {
		return false
	}
	digest, err = normalizeDigestLower(digest)
	if err != nil {
		return false
	}
	parsed, ok := ParseRef(key)
	return ok && parsed.Workspace == workspace && parsed.Digest == digest
}

func batchParts(key string) ([]string, bool) {
	tail, ok := uploadTail(key)
	if !ok {
		return nil, false
	}
	parts := strings.Split(tail, "/")
	if len(parts) != 7 {
		return nil, false
	}
	return parts, true
}

func uploadTail(key string) (string, bool) {
	if rest, ok := strings.CutPrefix(key, "uploads/"); ok {
		return rest, true
	}
	const mark = "/uploads/"
	idx := strings.LastIndex(key, mark)
	if idx < 0 {
		return "", false
	}
	return key[idx+len(mark):], true
}

func splitFile(file string) (digest, ext string, ok bool) {
	dot := strings.LastIndex(file, ".")
	if dot <= 0 || dot == len(file)-1 {
		return "", "", false
	}
	return file[:dot], file[dot+1:], true
}

func splitParent(head string) (parents, workspace string, ok bool) {
	slash := strings.LastIndex(head, "/")
	if slash < 0 {
		return "", head, head != ""
	}
	return head[:slash], head[slash+1:], true
}

func classFromParent(parents, ext string) (Class, bool) {
	var segment string
	switch {
	case parents == "teams" || parents == "workspaces":
		segment = ""
	case strings.HasSuffix(parents, "/teams"):
		segment = lastSegment(strings.TrimSuffix(parents, "/teams"))
	case strings.HasSuffix(parents, "/workspaces"):
		segment = lastSegment(strings.TrimSuffix(parents, "/workspaces"))
	default:
		return 0, false
	}
	switch segment {
	case "images":
		if ext != "jpg" && ext != "png" {
			return 0, false
		}
		return ClassImage, true
	case "videos":
		if ext != "mp4" && ext != "mov" {
			return 0, false
		}
		return ClassVideo, true
	default:
		switch ext {
		case "jpg", "png":
			return ClassImage, true
		case "mp4", "mov":
			return ClassVideo, true
		default:
			return 0, false
		}
	}
}

func lastSegment(value string) string {
	if i := strings.LastIndex(value, "/"); i >= 0 {
		return value[i+1:]
	}
	return value
}

func hasDotSegment(key string) bool {
	for _, segment := range strings.Split(key, "/") {
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

func dateMatches(timestamp, date string) bool {
	ms, err := parseMillis(timestamp)
	if err != nil {
		return false
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02") == date
}

func normalizeDigestLower(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if !isDigest(trimmed) {
		return "", ErrDigest
	}
	return strings.ToLower(trimmed), nil
}

func isDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if !isHex(value[i]) {
			return false
		}
	}
	return true
}

func isStoredExt(lower string) bool {
	switch lower {
	case "jpg", "png", "mp4", "mov":
		return true
	default:
		return false
	}
}

func isUUIDv4(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		switch i {
		case 8, 13, 18, 23:
			if value[i] != '-' {
				return false
			}
		default:
			if !isHex(value[i]) {
				return false
			}
		}
	}
	return value[14] == '4'
}

func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

func isUnreserved(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.' || b == '~'
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func parseMillis(timestamp string) (int64, error) {
	if !allDigits(timestamp) || len(timestamp) > 18 {
		return 0, ErrPrefix
	}
	var ms int64
	for i := 0; i < len(timestamp); i++ {
		ms = ms*10 + int64(timestamp[i]-'0')
	}
	return ms, nil
}
