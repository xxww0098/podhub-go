package contract

import (
	"strings"
	"testing"
)

func testBucket(role Role) Config {
	return Config{Role: role, Provider: "cloudflare", Endpoint: "https://account.r2.cloudflarestorage.com",
		Region: "auto", Bucket: BucketName(role), PublicBaseURL: PublicHost(role), ForcePathStyle: true,
		AccessKeyID: "test-access", SecretAccessKey: "test-secret"}
}

func TestValidateDevelopmentBucketNames(t *testing.T) {
	for _, name := range []string{"abc", "123", "podhub-test-delegate", strings.Repeat("a", 63)} {
		bucket := testBucket(RolePrivate)
		bucket.Bucket = name
		if err := bucket.Validate(); err != nil {
			t.Errorf("valid bucket %q: %v", name, err)
		}
	}
	for _, name := range []string{"", "ab", "Abc", "a_b", "a.b", "-abc", "abc-", "abc/def", strings.Repeat("a", 64)} {
		bucket := testBucket(RolePrivate)
		bucket.Bucket = name
		if err := bucket.Validate(); err != ErrBucket {
			t.Errorf("invalid bucket %q: %v", name, err)
		}
	}
}

func TestValidateBucketRoleAndPublicHost(t *testing.T) {
	const developmentHost = "https://pub-0123456789abcdef0123456789abcdef.r2.dev"
	for _, role := range AllRoles {
		bucket := testBucket(role)
		if err := bucket.Validate(); err != nil {
			t.Fatalf("production role %s: %v", role, err)
		}
		for _, other := range AllRoles {
			if other != role {
				bucket.Bucket = BucketName(other)
				if err := bucket.Validate(); err != ErrBucket {
					t.Errorf("production bucket %s accepted role %s: %v", bucket.Bucket, role, err)
				}
			}
		}
		bucket = testBucket(role)
		bucket.PublicBaseURL = developmentHost
		if err := bucket.Validate(); err != ErrPublicHost {
			t.Errorf("production role %s accepted another public host: %v", role, err)
		}
		bucket.Bucket = "podhub-test-" + string(role)
		if role == RolePrivate {
			if err := bucket.Validate(); err != ErrPublicHost {
				t.Errorf("private bucket accepted public host: %v", err)
			}
			bucket.PublicBaseURL = ""
		}
		if err := bucket.Validate(); err != nil {
			t.Errorf("development role %s: %v", role, err)
		}
	}
	for _, host := range []string{
		"", PublicHostAssets, "http://pub-0123456789abcdef0123456789abcdef.r2.dev",
		developmentHost + "/", developmentHost + "/path", developmentHost + "?query", developmentHost + "#fragment",
		developmentHost + ":443", "https://user@pub-0123456789abcdef0123456789abcdef.r2.dev",
		"https://pub-abc.r2.dev", "https://pub-gggggggggggggggggggggggggggggggg.r2.dev",
		developmentHost + ".example.com", "https://example.com",
	} {
		bucket := testBucket(RoleAssets)
		bucket.Bucket, bucket.PublicBaseURL = "podhub-test-supplier", host
		if err := bucket.Validate(); err != ErrPublicHost {
			t.Errorf("development bucket accepted host %q: %v", host, err)
		}
	}
}
