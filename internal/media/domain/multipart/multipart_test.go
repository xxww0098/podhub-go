package multipart

import (
	"strings"
	"testing"
	"time"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func TestPartCountAndXML(t *testing.T) {
	count, err := PartCount(PartSize + 1)
	if err != nil || count != 2 {
		t.Fatalf("count %d %v", count, err)
	}
	if UsesMultipart(PartSize) {
		t.Fatal("one part is a single PUT")
	}
	xml, err := CompleteXML([]struct {
		Number uint32
		ETag   string
	}{
		{Number: 2, ETag: `"bbbbbbbbbbbbbbbb"`},
		{Number: 1, ETag: "W/\"aaaaaaaaaaaaaaaa\""},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(xml, "<PartNumber>1</PartNumber>") || !strings.Contains(xml, "<ETag>\"aaaaaaaaaaaaaaaa\"</ETag>") {
		t.Fatalf("xml %s", xml)
	}
	if _, err := CompleteXML([]struct {
		Number uint32
		ETag   string
	}{{Number: 2, ETag: `"aaaaaaaaaaaaaaaa"`}}); err == nil {
		t.Fatal("a gap in part numbers must fail")
	}
}

func TestPartURLOmitsIfNoneMatch(t *testing.T) {
	account := sign.Account{
		Provider: sign.ProviderCloudflare, Endpoint: "https://s3.example.com",
		Region: "auto", Bucket: "podhub-slices", ForcePathStyle: true,
		AccessKeyID: "AKID", SecretAccessKey: "secret",
	}
	parts, err := PresignParts(account, "images/a.jpg", "upload-1", PartSize+1, time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	if err != nil || len(parts) != 2 {
		t.Fatalf("%d %v", len(parts), err)
	}
	if strings.Contains(parts[0].Canonical, "if-none-match") {
		t.Fatal("part PUT must not sign if-none-match")
	}
	if !strings.Contains(parts[0].URL, "partNumber=1") || !strings.Contains(parts[0].URL, "uploadId=upload-1") {
		t.Fatalf("url %s", parts[0].URL)
	}
	if parts[0].ByteLength != PartSize || parts[1].ByteLength != 1 {
		t.Fatalf("lengths %d %d", parts[0].ByteLength, parts[1].ByteLength)
	}
}

func TestJudgeAssembly(t *testing.T) {
	length := uint64(9)
	kind, _, ok := JudgeAssembly(`"0123456789abcdef-2"`, "", &length, "digest", length, 2)
	if !ok || kind != AssemblyETag {
		t.Fatalf("etag %v %v", kind, ok)
	}
	if _, fault, ok := JudgeAssembly(`"0123456789abcdef-1"`, "", &length, "digest", length, 2); ok || fault != FaultMismatch {
		t.Fatal("part count mismatch")
	}
	kind, _, ok = JudgeAssembly("", strings.Repeat("ab", 32), &length, strings.Repeat("ab", 32), length, 2)
	if !ok || kind != AssemblyChecksum {
		t.Fatal("checksum wins")
	}
}
