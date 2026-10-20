package archtest

import "testing"

func TestGUCMatchesBacktickAndSQLQuotes(t *testing.T) {
	const needle = "app.current_org_id"
	sql := "SELECT set_config('" + needle + "', $1, true)"
	hits := []string{
		`const name = "` + needle + `"`,
		"`" + sql + "`",
		"`SELECT current_setting('" + needle + "', true)`",
		`const q = "` + sql + `"`,
	}
	for _, src := range hits {
		if !gucInSource(src, needle) {
			t.Errorf("missed GUC source: %s", src)
		}
	}
	misses := []string{
		"// " + needle + " is set in tenantx",
		`return fmt.Errorf("` + needle + ` is unset")`,
		"`SELECT set_config('role', 'podhub_app', true)`",
		`const other = "app.current_wallet_user_id"`,
	}
	for _, src := range misses {
		if gucInSource(src, needle) {
			t.Errorf("false GUC hit: %s", src)
		}
	}
}

func TestEnvSelectorIgnoresCommentsAndStrings(t *testing.T) {
	hits := []struct {
		needle string
		src    string
	}{
		{"os.Getenv", "path := os.Getenv(key)"},
		{"os.LookupEnv", `secret, ok := os.LookupEnv("CLOUD_SELLER_CREDENTIAL_KEY")`},
		{"os.Getenv", "fn := os.Getenv\n_ = fn"},
	}
	for _, tc := range hits {
		if !selectorInSource(tc.src, tc.needle) {
			t.Errorf("missed %s in %s", tc.needle, tc.src)
		}
	}
	misses := []string{
		"// os.Getenv stays in platform/config",
		`forbidden := []string{"os.Getenv", "os.LookupEnv"}`,
		"path := other.Getenv(key)",
		"path := os.Getpid()",
	}
	for _, src := range misses {
		if selectorInSource(src, "os.Getenv") || selectorInSource(src, "os.LookupEnv") {
			t.Errorf("false env hit: %s", src)
		}
	}
}
