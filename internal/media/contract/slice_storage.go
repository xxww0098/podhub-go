package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

var userR2Endpoint = regexp.MustCompile(`^[a-f0-9]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$`)

// SlicePrefix isolates each saved configuration inside its owner's bucket.
func SlicePrefix(id string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.Version() != 4 || parsed.String() != id {
		return "", errors.New("invalid slice storage identity")
	}
	return "podhub-slices/" + id + "/", nil
}

func SliceClearIdentity(kind, id string) string {
	sum := sha256.Sum256([]byte("user-slice-clear:" + kind + ":" + id))
	return hex.EncodeToString(sum[:])
}

// ValidateSliceStorage accepts an R2 bucket and a publicly reachable HTTPS origin.
func (c Config) ValidateSliceStorage() error {
	if c.Role != RoleTransit || c.Provider != "cloudflare" || c.Region != "auto" || !c.ForcePathStyle || !bucketNamePattern.MatchString(c.Bucket) {
		return ErrIdentity
	}
	endpoint, err := url.Parse(c.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.User != nil || endpoint.Port() != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Path != "" && endpoint.Path != "/") || !userR2Endpoint.MatchString(strings.ToLower(endpoint.Hostname())) {
		return ErrEndpoint
	}
	public, err := url.Parse(c.PublicBaseURL)
	if err != nil || public.Scheme != "https" || public.User != nil || public.Hostname() == "" || public.Port() != "" || public.RawQuery != "" || public.Fragment != "" || (public.Path != "" && public.Path != "/") || net.ParseIP(public.Hostname()) != nil || strings.EqualFold(public.Hostname(), "localhost") {
		return ErrPublicHost
	}
	if len(c.AccessKeyID) < 1 || len(c.AccessKeyID) > 256 || len(c.SecretAccessKey) < 1 || len(c.SecretAccessKey) > 256 || strings.ContainsAny(c.AccessKeyID+c.SecretAccessKey, " \t\r\n") {
		return ErrIdentity
	}
	if _, err := NormalizePrefix(c.KeyPrefix); err != nil {
		return err
	}
	return nil
}
