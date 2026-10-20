// Package multipart is the PSD part plan from src/media/multipart.rs.
// Part URLs are signed here. Creating the upload id on a bucket goes through
// the fake S3 client in tests; this package does not dial.
package multipart

import (
	"fmt"
	"strings"
	"time"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const (
	// PartSize is 16 MiB. Every part except the last stays above R2's 5 MiB minimum.
	PartSize uint64 = 16 * 1024 * 1024
	partTTL         = time.Hour
	maxParts uint32 = 10_000
)

// ErrInvalid is a rejected part list or empty object.
var ErrInvalid = sign.Error{Message: "分片列表无效"}

// Part is one browser PUT.
type Part struct {
	Number     uint32
	URL        string
	ByteLength uint64
	ExpiresAt  time.Time
	Canonical  string
}

// Assembly is how a completed multipart object was proved.
type Assembly int

const (
	// AssemblyChecksum means the store returned the full-object SHA-256.
	AssemblyChecksum Assembly = iota
	// AssemblyETag means the multipart ETag's -N matched the part count.
	AssemblyETag
)

// Fault is why assembly was not proved.
type Fault int

const (
	// FaultUnproven means the store returned neither checksum nor a usable ETag.
	FaultUnproven Fault = iota
	// FaultMismatch means the store contradicted the declared object.
	FaultMismatch
)

// UsesMultipart reports objects larger than one part.
func UsesMultipart(bytes uint64) bool { return bytes > PartSize }

// PartCount is div_ceil(bytes, PartSize), capped at 10_000.
func PartCount(bytes uint64) (uint32, error) {
	if bytes == 0 {
		return 0, sign.Error{Message: "分片上传的文件是空的"}
	}
	count := (bytes + PartSize - 1) / PartSize
	if count == 0 || count > uint64(maxParts) {
		return 0, sign.Error{Message: "分片数量超出对象存储上限"}
	}
	return uint32(count), nil
}

// PartLength is the byte length of a 1-based part.
func PartLength(bytes uint64, number uint32) uint64 {
	if number == 0 {
		return 0
	}
	start := uint64(number-1) * PartSize
	if start >= bytes {
		return 0
	}
	rest := bytes - start
	if rest > PartSize {
		return PartSize
	}
	return rest
}

// PresignParts signs each part PUT with content-length and content-type.
// If-None-Match is not a part header.
func PresignParts(account sign.Account, key, uploadID string, bytes uint64, now time.Time) ([]Part, error) {
	if uploadID == "" || len(uploadID) > 1024 || hasControl(uploadID) {
		return nil, sign.Error{Message: "分片上传编号无效"}
	}
	count, err := PartCount(bytes)
	if err != nil {
		return nil, err
	}
	parts := make([]Part, 0, count)
	for number := uint32(1); number <= count; number++ {
		length := PartLength(bytes, number)
		rawURL, canonical, err := sign.PresignURL(account, "PUT", key, "application/octet-stream", now, partTTL,
			[][2]string{
				{"partNumber", fmt.Sprintf("%d", number)},
				{"uploadId", uploadID},
			},
			[][2]string{{"content-length", fmt.Sprintf("%d", length)}},
		)
		if err != nil {
			return nil, err
		}
		parts = append(parts, Part{
			Number: number, URL: rawURL, ByteLength: length,
			ExpiresAt: now.UTC().Add(partTTL), Canonical: canonical,
		})
	}
	return parts, nil
}

// CompleteXML is the CompleteMultipartUpload body. Part numbers must be 1..N exactly once.
func CompleteXML(parts []struct {
	Number uint32
	ETag   string
}) (string, error) {
	if len(parts) == 0 || len(parts) > int(maxParts) {
		return "", sign.Error{Message: "分片列表无效"}
	}
	seen := make([]bool, len(parts))
	var xml strings.Builder
	xml.WriteString("<CompleteMultipartUpload>")
	for _, part := range parts {
		index := int(part.Number) - 1
		if part.Number == 0 || index >= len(seen) || seen[index] {
			return "", sign.Error{Message: "分片序号不连续"}
		}
		seen[index] = true
		quoted, ok := quotedETag(part.ETag)
		if !ok {
			return "", sign.Error{Message: "分片 ETag 无效"}
		}
		xml.WriteString("<Part><PartNumber>")
		xml.WriteString(fmt.Sprintf("%d", part.Number))
		xml.WriteString("</PartNumber><ETag>")
		xml.WriteString(xmlEscape(quoted))
		xml.WriteString("</ETag></Part>")
	}
	for _, ok := range seen {
		if !ok {
			return "", sign.Error{Message: "分片序号不连续"}
		}
	}
	xml.WriteString("</CompleteMultipartUpload>")
	return xml.String(), nil
}

// JudgeAssembly prefers a full-object checksum, then a multipart ETag whose -N matches.
func JudgeAssembly(etag, sha256Hex string, byteLength *uint64, expectedSHA string, expectedLen uint64, parts uint32) (Assembly, Fault, bool) {
	if sha256Hex != "" {
		if sha256Hex != expectedSHA || byteLength == nil || *byteLength != expectedLen {
			return 0, FaultMismatch, false
		}
		return AssemblyChecksum, 0, true
	}
	if byteLength == nil {
		return 0, FaultUnproven, false
	}
	if *byteLength != expectedLen {
		return 0, FaultMismatch, false
	}
	n, ok := multipartParts(etag)
	if !ok {
		return 0, FaultUnproven, false
	}
	if n != parts {
		return 0, FaultMismatch, false
	}
	return AssemblyETag, 0, true
}

func quotedETag(raw string) (string, bool) {
	inner := strings.TrimSpace(raw)
	inner = strings.TrimPrefix(inner, "W/")
	inner = strings.TrimSpace(inner)
	inner = strings.Trim(inner, `"`)
	if inner == "" || len(inner) > 128 {
		return "", false
	}
	for i := 0; i < len(inner); i++ {
		c := inner[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '/' || c == '=' || c == '_' {
			continue
		}
		return "", false
	}
	return `"` + inner + `"`, true
}

func multipartParts(etag string) (uint32, bool) {
	etag = strings.Trim(strings.TrimSpace(etag), `"`)
	body, count, ok := strings.Cut(etag, "-")
	// rsplit_once: the last hyphen. Cut is the first. ETags are hex-count, one hyphen.
	if strings.Count(etag, "-") != 1 {
		idx := strings.LastIndex(etag, "-")
		if idx <= 0 {
			return 0, false
		}
		body, count = etag[:idx], etag[idx+1:]
	} else if !ok {
		return 0, false
	}
	if len(body) < 16 || len(body) > 128 || !hexDigits(body) {
		return 0, false
	}
	var n uint32
	for i := 0; i < len(count); i++ {
		if count[i] < '0' || count[i] > '9' {
			return 0, false
		}
		n = n*10 + uint32(count[i]-'0')
	}
	if n == 0 {
		return 0, false
	}
	return n, true
}

func hexDigits(value string) bool {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func xmlEscape(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	value = strings.ReplaceAll(value, ">", "&gt;")
	return value
}

func hasControl(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 32 {
			return true
		}
	}
	return false
}
