// Package checksum is the full-object SHA-256 verdict from
// src/media/upload/checksum.rs. A "-N" checksum is multipart and is not proof.
package checksum

import sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"

// Verdict is what a HEAD checksum proves.
type Verdict int

const (
	// Unproven means the store did not return a usable full-object checksum.
	Unproven Verdict = iota
	// Trusted means digest, length and content type all matched.
	Trusted
	// Mismatch means the store contradicted the browser claim.
	Mismatch
)

// Head is the subset of a HEAD response the verdict reads.
type Head struct {
	ByteLength  *uint64
	ContentType string
	SHA256Hex   string
	HasSHA256   bool
	HasType     bool
}

// Judge matches checksum::verdict.
func Judge(head Head, sha256Hex string, byteLength uint64, contentType string) Verdict {
	if !head.HasSHA256 {
		return Unproven
	}
	if head.SHA256Hex != sha256Hex || head.ByteLength == nil || *head.ByteLength != byteLength {
		return Mismatch
	}
	if !head.HasType {
		return Unproven
	}
	if head.ContentType != contentType {
		return Mismatch
	}
	return Trusted
}

// ParseChecksumHeader decodes x-amz-checksum-sha256 when it is a full object.
func ParseChecksumHeader(header string) (string, bool) {
	return sign.FullObjectSHA256(header)
}
