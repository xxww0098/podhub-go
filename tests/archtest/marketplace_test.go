package archtest

import (
	"fmt"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMarketplaceImportBoundaries(t *testing.T) {
	// A second adapter is a test fixture, not an implemented capability.
	level["seller/wildberries"] = 3
	defer delete(level, "seller/wildberries")
	cases := []struct {
		from, to string
		allowed  bool
	}{
		{"queue/service", "seller/ozon", false},
		{"queue/service", "seller/ozon/contract", false},
		{"platform/httpx", "seller/ozon", false},
		{"seller/ozon", "app", false},
		{"seller/ozon", "seller/wildberries", false},
		{"seller/ozon", "seller/wildberries/contract", false},
		{"seller/ozon/domain", "seller/contract", true},
		{"seller/ozon/repo", "seller/ozon/domain", true},
		{"seller/ozon", "platform/httpx", true},
		{"app", "seller/ozon", true},
	}
	for _, tc := range cases {
		t.Run(tc.from+"->"+tc.to, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "internal", tc.from)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			source := fmt.Sprintf("package fixture\nimport _ %q\n", modulePath+"internal/"+tc.to)
			if err := os.WriteFile(filepath.Join(dir, "fixture.go"), []byte(source), 0o644); err != nil {
				t.Fatal(err)
			}
			got := violations(t, root)
			if (len(got) == 0) != tc.allowed {
				t.Fatalf("allowed=%v, violations=%v", tc.allowed, got)
			}
		})
	}
}

func TestQueueHasNoMarketplaceProtocol(t *testing.T) {
	err := filepath.WalkDir("../../internal/queue", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if hasMarketplaceProtocol(string(source)) {
			t.Errorf("%s: queue must not own marketplace hosts or HTTP endpoints", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func hasMarketplaceProtocol(source string) bool {
	return scanTokens(source, func(tok token.Token, literal string) bool {
		if tok != token.STRING {
			return false
		}
		value, err := strconv.Unquote(literal)
		if err != nil {
			return false
		}
		value = strings.ToLower(value)
		if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") ||
			strings.Contains(value, "ozon.ru") || strings.Contains(value, "wildberries.ru") {
			return true
		}
		if !strings.HasPrefix(value, "/") {
			return false
		}
		segment, _, _ := strings.Cut(value[1:], "/")
		if segment == "api" || segment == "content" || segment == "adv" {
			return true
		}
		_, err = strconv.Atoi(strings.TrimPrefix(segment, "v"))
		return strings.HasPrefix(segment, "v") && err == nil
	})
}

func TestMarketplaceProtocolUsesStringTokens(t *testing.T) {
	cases := []struct {
		source string
		want   bool
	}{
		{`const endpoint = "/v3/product/import"`, true},
		{"const endpoint = `/content/v2/cards/upload`", true},
		{`const endpoint = "/api/v3/orders"`, true},
		{`const host = "api-seller.ozon.ru"`, true},
		{`const host = "marketplace-api.wildberries.ru"`, true},
		{`const origin = "https://seller.example"`, true},
		{`const endpoint = "\x2fv3/product/import"`, true},
		{`const kind = "listing.submit.batch"`, false},
		{`const state = "Ozon response unavailable"`, false},
		{`const query = "SELECT * FROM public.jobs"`, false},
		{`// Previously sent to "https://api-seller.ozon.ru/v3/product/import"`, false},
	}
	for _, tc := range cases {
		if got := hasMarketplaceProtocol(tc.source); got != tc.want {
			t.Errorf("hasMarketplaceProtocol(%q) = %v, want %v", tc.source, got, tc.want)
		}
	}
}
