package config

import (
	"os"
	"strings"
	"testing"
)

// envCase is one environment state. set=false unsets the variable.
type envCase struct {
	name  string
	value string
	set   bool
}

func withEnv(t *testing.T, key string, c envCase) {
	t.Helper()
	if c.set {
		t.Setenv(key, c.value)
		return
	}
	t.Setenv(key, "")
	os.Unsetenv(key)
}

var commonCases = []envCase{
	{name: "unset"},
	{name: "empty", value: "", set: true},
	{name: "blank", value: "   ", set: true},
	{name: "tabs", value: "\t\n", set: true},
	{name: "one", value: "1", set: true},
	{name: "padded one", value: " 1 ", set: true},
	{name: "zero", value: "0", set: true},
	{name: "false", value: "false", set: true},
	{name: "padded false", value: "\tfalse\n", set: true},
	{name: "FALSE", value: "FALSE", set: true},
	{name: "true", value: "true", set: true},
	{name: "no", value: "no", set: true},
	{name: "word", value: "tenant-a", set: true},
	{name: "padded word", value: "  tenant-a  ", set: true},
	{name: "inner space", value: "a b", set: true},
	{name: "invalid utf8", value: "\xff\xfe", set: true},
}

// The legacy* functions are the bodies removed from their old packages,
// copied byte for byte. Each test feeds both the same environment.

func legacyAllowSuperuserDB() bool {
	return os.Getenv("PODHUB_ALLOW_SUPERUSER_DB") == "1"
}

func legacyCookieSecureAttribute() string {
	switch strings.TrimSpace(os.Getenv("CLOUD_COOKIE_SECURE")) {
	case "0", "false":
		return ""
	default:
		return "; Secure"
	}
}

func legacySessionPepperSecret() (string, bool) {
	return os.LookupEnv("CLOUD_SELLER_CREDENTIAL_KEY")
}

func legacyNamespace() string {
	raw := strings.TrimSpace(os.Getenv("CLOUD_SELLER_BUDGET_NAMESPACE"))
	if raw == "" {
		return "podhub"
	}
	return raw
}

func TestAllowSuperuserDBMatchesLegacy(t *testing.T) {
	want := map[string]bool{"one": true}
	for _, c := range commonCases {
		t.Run(c.name, func(t *testing.T) {
			withEnv(t, "PODHUB_ALLOW_SUPERUSER_DB", c)
			got := AllowSuperuserDB()
			if got != legacyAllowSuperuserDB() || got != want[c.name] {
				t.Fatalf("%q: got %v legacy %v want %v", c.value, got, legacyAllowSuperuserDB(), want[c.name])
			}
		})
	}
}

func TestCookieSecureAttributeMatchesLegacy(t *testing.T) {
	insecure := map[string]bool{"zero": true, "false": true, "padded false": true}
	for _, c := range commonCases {
		t.Run(c.name, func(t *testing.T) {
			withEnv(t, "CLOUD_COOKIE_SECURE", c)
			want := "; Secure"
			if insecure[c.name] {
				want = ""
			}
			got := CookieSecureAttribute()
			if got != legacyCookieSecureAttribute() || got != want {
				t.Fatalf("%q: got %q legacy %q want %q", c.value, got, legacyCookieSecureAttribute(), want)
			}
		})
	}
}

func TestSessionPepperSecretMatchesLegacy(t *testing.T) {
	for _, c := range commonCases {
		t.Run(c.name, func(t *testing.T) {
			withEnv(t, "CLOUD_SELLER_CREDENTIAL_KEY", c)
			got, ok := SessionPepperSecret()
			legacy, legacyOK := legacySessionPepperSecret()
			if got != legacy || ok != legacyOK || got != c.value || ok != c.set {
				t.Fatalf("%q/%v: got %q/%v legacy %q/%v", c.value, c.set, got, ok, legacy, legacyOK)
			}
		})
	}
}

func TestSellerBudgetNamespaceMatchesLegacy(t *testing.T) {
	for _, c := range commonCases {
		t.Run(c.name, func(t *testing.T) {
			withEnv(t, "CLOUD_SELLER_BUDGET_NAMESPACE", c)
			want := strings.TrimSpace(c.value)
			if want == "" {
				want = "podhub"
			}
			got := SellerBudgetNamespace()
			if got != legacyNamespace() || got != want {
				t.Fatalf("%q: got %q legacy %q want %q", c.value, got, legacyNamespace(), want)
			}
		})
	}
}

// The two switch parsers are not moved. This table pins their current
// results so a later move can be checked against the same inputs.
func TestSwitchParsersPinned(t *testing.T) {
	type row struct {
		value      string
		set        bool
		killSwitch bool
		mediaGC    bool
	}
	rows := []row{
		{value: "", set: false, killSwitch: false, mediaGC: true},
		{value: "", set: true, killSwitch: false, mediaGC: false},
		{value: "   ", set: true, killSwitch: false, mediaGC: false},
		{value: "1", set: true, killSwitch: true, mediaGC: true},
		{value: "true", set: true, killSwitch: true, mediaGC: true},
		{value: " TRUE ", set: true, killSwitch: true, mediaGC: true},
		{value: "yes", set: true, killSwitch: true, mediaGC: true},
		{value: "On", set: true, killSwitch: true, mediaGC: true},
		{value: "0", set: true, killSwitch: false, mediaGC: false},
		{value: "false", set: true, killSwitch: false, mediaGC: false},
		{value: "off", set: true, killSwitch: false, mediaGC: false},
		{value: "no", set: true, killSwitch: false, mediaGC: false},
		{value: "2", set: true, killSwitch: false, mediaGC: false},
		{value: "enabled", set: true, killSwitch: false, mediaGC: false},
		{value: "\xff", set: true, killSwitch: false, mediaGC: false},
	}
	for _, r := range rows {
		if r.set {
			if got := isTruthy(r.value); got != r.killSwitch {
				t.Errorf("isTruthy(%q) = %v, want %v", r.value, got, r.killSwitch)
			}
		}
		if got := mediaDeleteEnabled(r.value, r.set); got != r.mediaGC {
			t.Errorf("mediaDeleteEnabled(%q, %v) = %v, want %v", r.value, r.set, got, r.mediaGC)
		}
	}
}
