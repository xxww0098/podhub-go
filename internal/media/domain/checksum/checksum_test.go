package checksum

import (
	"strings"
	"testing"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestJudge(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	length := uint64(12)
	trusted := Head{ByteLength: &length, ContentType: "image/jpeg", SHA256Hex: sha, HasSHA256: true, HasType: true}
	if Judge(trusted, sha, length, "image/jpeg") != Trusted {
		t.Fatal("matching head must be trusted")
	}
	missing := trusted
	missing.HasSHA256 = false
	if Judge(missing, sha, length, "image/jpeg") != Unproven {
		t.Fatal("a missing checksum is unproven")
	}
	wrong := trusted
	wrong.SHA256Hex = strings.Repeat("cd", 32)
	if Judge(wrong, sha, length, "image/jpeg") != Mismatch {
		t.Fatal("a different digest is a mismatch")
	}
	noType := trusted
	noType.HasType = false
	if Judge(noType, sha, length, "image/jpeg") != Unproven {
		t.Fatal("a checksum without a content type is unproven")
	}
	badType := trusted
	badType.ContentType = "image/png"
	if Judge(badType, sha, length, "image/jpeg") != Mismatch {
		t.Fatal("a different content type is a mismatch")
	}
}

func TestParseChecksumHeaderRejectsMultipart(t *testing.T) {
	encoded, ok := sign.ChecksumB64(strings.Repeat("ab", 32))
	if !ok {
		t.Fatal("encode")
	}
	got, ok := ParseChecksumHeader(encoded)
	if !ok || got != strings.Repeat("ab", 32) {
		t.Fatalf("full object checksum %q %v", got, ok)
	}
	if _, ok := ParseChecksumHeader(encoded + "-2"); ok {
		t.Fatal("a -N checksum is not a full object")
	}
}
