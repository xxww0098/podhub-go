package config

import (
	"os"
	"strings"
)

// These readers run on every call, not once at Load. Their callers read per
// request or per connection, and tests set the variable just before the call.

const (
	envAllowSuperuserDB = "PODHUB_ALLOW_SUPERUSER_DB"
	envCookieSecure     = "CLOUD_COOKIE_SECURE"
	envBudgetNamespace  = "CLOUD_SELLER_BUDGET_NAMESPACE"
	defaultNamespace    = "podhub"
)

// AllowSuperuserDB reports PODHUB_ALLOW_SUPERUSER_DB. Only the exact value 1
// lets a superuser or BYPASSRLS login open the pool.
func AllowSuperuserDB() bool {
	return os.Getenv(envAllowSuperuserDB) == "1"
}

// CookieSecureAttribute is "; Secure" unless CLOUD_COOKIE_SECURE is 0 or false after trim.
func CookieSecureAttribute() string {
	switch strings.TrimSpace(os.Getenv(envCookieSecure)) {
	case "0", "false":
		return ""
	default:
		return "; Secure"
	}
}

// SessionPepperSecret is CLOUD_SELLER_CREDENTIAL_KEY as set, untrimmed.
// ok is false only when the variable is unset; an empty value is set.
func SessionPepperSecret() (secret string, ok bool) {
	return os.LookupEnv(envSellerKey)
}

// SellerBudgetNamespace is CLOUD_SELLER_BUDGET_NAMESPACE trimmed, or podhub
// when that is empty.
func SellerBudgetNamespace() string {
	raw := strings.TrimSpace(os.Getenv(envBudgetNamespace))
	if raw == "" {
		return defaultNamespace
	}
	return raw
}
