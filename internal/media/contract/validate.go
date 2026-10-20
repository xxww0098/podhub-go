package contract

import (
	"net/url"
	"strings"
)

// Validate checks one configured bucket against its role. A role accepts one
// hostname and one provider; there is no fallback.
func (c Config) Validate() error {
	role, err := ParseRole(string(c.Role))
	if err != nil {
		return err
	}
	if strings.TrimSpace(c.Bucket) != BucketName(role) {
		return ErrBucket
	}
	if strings.TrimSpace(c.Provider) != "cloudflare" {
		return ErrProvider
	}
	if err := validateEndpoint(c.Endpoint); err != nil {
		return err
	}
	if strings.TrimSpace(c.Region) != "auto" || !c.ForcePathStyle {
		return ErrEndpoint
	}
	if strings.TrimSpace(c.AccessKeyID) == "" || strings.TrimSpace(c.SecretAccessKey) == "" {
		return ErrIdentity
	}
	if _, err := NormalizePrefix(c.KeyPrefix); err != nil {
		return err
	}
	want := PublicHost(role)
	got := strings.TrimRight(strings.TrimSpace(c.PublicBaseURL), "/")
	if got != want {
		return ErrPublicHost
	}
	return nil
}

// validateEndpoint accepts only an HTTPS R2 API host: no port, no userinfo,
// no path beyond "/", no query and no fragment. A redirect or a proxy endpoint
// is refused here, before any request is built.
func validateEndpoint(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil {
		return ErrEndpoint
	}
	if parsed.Scheme != "https" || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ErrEndpoint
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return ErrEndpoint
	}
	host := strings.ToLower(parsed.Hostname())
	if !strings.HasSuffix(host, r2APIHostSuffix) || len(host) == len(r2APIHostSuffix) {
		return ErrEndpoint
	}
	return nil
}

// EndpointHost is the lowercase hostname of a validated endpoint.
func EndpointHost(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}
