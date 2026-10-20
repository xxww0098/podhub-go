package sigv4

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

func TestChecksumFollowsTheStore(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		provider Provider
		endpoint string
		enforced bool
	}{
		{ProviderCloudflare, "https://s3.example.com", true},
		{ProviderLegacyS3, "https://accountidaccountidaccountidacct.r2.cloudflarestorage.com", true},
		{ProviderGeneric, "https://accountidaccountidaccountidacct.eu.r2.cloudflarestorage.com", true},
		{ProviderGeneric, "https://accountidaccountidaccountidacct.fedramp.r2.cloudflarestorage.com", true},
		{ProviderGeneric, "https://accountidaccountidaccountidacct.eu.extra.r2.cloudflarestorage.com", false},
		{ProviderGeneric, "https://s3.eu-west-1.amazonaws.com", true},
		{ProviderGeneric, "https://s3.amazonaws.com", true},
		{ProviderGeneric, "https://s3-fips.us-east-1.amazonaws.com", true},
		{ProviderGeneric, "https://s3.dualstack.ap-southeast-1.amazonaws.com", true},
		{ProviderGeneric, "https://s3.cn-north-1.amazonaws.com.cn", true},
		{ProviderQiniu, "https://s3.cn-east-1.qiniucs.com", false},
		{ProviderTencent, "https://cos.ap-guangzhou.myqcloud.com", false},
		{ProviderAliyun, "https://oss-cn-hangzhou.aliyuncs.com", false},
		{ProviderQiniu, "https://s3.amazonaws.com", false},
		{ProviderGeneric, "https://minio.example", false},
		{ProviderLegacyS3, "https://s3.example.invalid", false},
		{ProviderGeneric, "https://bucket.s3.amazonaws.com", false},
		{ProviderGeneric, "https://s3.amazonaws.com.evil.test", false},
	}
	for _, tc := range cases {
		account := testAccount(tc.provider, tc.endpoint)
		grant, err := SignPut(account, "objects/file.jpg", "image/jpeg", 12, now, sha, nil)
		if err != nil {
			t.Fatal(err)
		}
		got := strings.Contains(strings.ToLower(grant.URL), "x-amz-checksum-sha256")
		if got != tc.enforced || (grant.ChecksumSHA256 != "") != tc.enforced {
			t.Fatalf("%s %s enforced=%v url has checksum=%v", tc.provider, tc.endpoint, tc.enforced, got)
		}
		if !strings.Contains(grant.Canonical, "content-length:12\n") || !strings.Contains(grant.Canonical, "if-none-match:*\n") {
			t.Fatalf("signed headers missing\n%s", grant.Canonical)
		}
		if tc.enforced && !strings.Contains(grant.Canonical, "x-amz-checksum-sha256:") {
			t.Fatal("enforced grant must sign the checksum header")
		}
	}
}

func TestSignatureMatchesIndependentHMAC(t *testing.T) {
	account := testAccount(ProviderCloudflare, "https://s3.example.com")
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	grant, err := SignPut(account, "objects/file.jpg", "image/jpeg", 12, now, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Recompute the signature from the canonical request the signer returned.
	// This HMAC does not call PresignURL.
	day := "20261015"
	stamp := "20261015T120000Z"
	scope := day + "/auto/s3/aws4_request"
	sum := sha256.Sum256([]byte(grant.Canonical))
	stringToSign := "AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	key := hmacSHA256([]byte("AWS4"+account.SecretAccessKey), []byte(day))
	key = hmacSHA256(key, []byte("auto"))
	key = hmacSHA256(key, []byte("s3"))
	key = hmacSHA256(key, []byte("aws4_request"))
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(stringToSign))
	want := hex.EncodeToString(mac.Sum(nil))
	if !strings.Contains(grant.URL, "X-Amz-Signature="+want) {
		t.Fatalf("signature mismatch\ncanonical:\n%s", grant.Canonical)
	}
	if !strings.Contains(grant.URL, "X-Amz-SignedHeaders=") || !strings.Contains(grant.Canonical, "UNSIGNED-PAYLOAD") {
		t.Fatal(grant.URL)
	}
}

func testAccount(provider Provider, endpoint string) Account {
	return Account{
		ID: "env-media", Provider: provider, Endpoint: endpoint, Region: "auto",
		Bucket: "pod-media", PublicBaseURL: "https://media.example.com", ForcePathStyle: true,
		AccessKeyID: "AKIAEXAMPLEKEYID", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	}
}
