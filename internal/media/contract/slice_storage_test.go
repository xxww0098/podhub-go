package contract

import (
	"strings"
	"testing"
)

func TestSliceConfiguration(t *testing.T) {
	c := Config{Role: RoleTransit, Provider: "cloudflare", Endpoint: "https://" + strings.Repeat("a", 32) + ".r2.cloudflarestorage.com", Region: "auto", Bucket: "my-bucket", PublicBaseURL: "https://cdn.example.com", ForcePathStyle: true, AccessKeyID: "access", SecretAccessKey: "secret"}
	if err := c.ValidateSliceStorage(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://cdn.example.com", "https://127.0.0.1", "https://localhost", "https://cdn.example.com/path", "https://cdn.example.com?x=1"} {
		c.PublicBaseURL = bad
		if c.ValidateSliceStorage() == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	c.PublicBaseURL = "https://cdn.example.com"
	c.Endpoint = "https://example.r2.cloudflarestorage.com"
	if c.ValidateSliceStorage() == nil {
		t.Fatal("accepted invalid account endpoint")
	}
}
