package contract

import (
	"net/url"
	"regexp"
	"strings"
)

var (
	bucketNamePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
	developmentHostPattern = regexp.MustCompile(`^https://pub-[0-9a-f]{32}\.r2\.dev$`)
)

// Validate keeps production bucket roles fixed and allows explicit development buckets.
func (c Config) Validate() error {
	role, err := ParseRole(string(c.Role))
	if err != nil {
		return err
	}
	bucket := strings.TrimSpace(c.Bucket)
	if !bucketNamePattern.MatchString(bucket) {
		return ErrBucket
	}
	switch bucket {
	case BucketTransit, BucketAssets, BucketPrivate:
		if bucket != BucketName(role) {
			return ErrBucket
		}
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
	publicBase := strings.TrimSpace(c.PublicBaseURL)
	switch {
	case role == RolePrivate:
		if publicBase != "" {
			return ErrPublicHost
		}
	case bucket == BucketName(role):
		if strings.TrimRight(publicBase, "/") != PublicHost(role) {
			return ErrPublicHost
		}
	case !developmentHostPattern.MatchString(publicBase):
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
