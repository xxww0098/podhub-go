package slicepurge

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
)

// podhubTransitBucket is the only bucket this job may name. The allowlist is
// literal: the physical bucket name is not configuration.
const podhubTransitBucket = "podhub-transit"

// Account is the subset of a bucket account the clear identity uses.
type Account struct {
	Role            string
	Provider        string
	Endpoint        string
	Region          string
	Bucket          string
	KeyPrefix       string
	ForcePathStyle  bool
	AccessKeyID     string
	SecretAccessKey string
}

// FakeFingerprint is the receipt key for a 127.0.0.1 drill. The preimage
// starts with "fake:" so a real account can never produce it.
func FakeFingerprint(bucket string) string {
	sum := sha256.Sum256([]byte("fake:127.0.0.1:" + bucket))
	return hex.EncodeToString(sum[:])
}

// Fingerprint is the physical identity of a transit bucket: endpoint, bucket
// and prefix. Credentials, labels and account ids are excluded, so rotating a
// key or renaming an account does not reset the daily continuity.
func Fingerprint(account Account) (string, error) {
	if account.Provider != "cloudflare" && account.Provider != "generic" {
		return "", errCode("slice_provider_invalid")
	}
	return physicalFingerprint(account)
}

func physicalFingerprint(account Account) (string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(account.Endpoint))
	if err != nil || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return "", errCode("slice_endpoint_invalid")
	}
	host := endpoint.Hostname()
	loopback := endpoint.Scheme == "http" && host == "127.0.0.1"
	if !loopback {
		namespace, ok := strings.CutSuffix(host, ".r2.cloudflarestorage.com")
		if endpoint.Scheme != "https" || endpoint.Port() != "" ||
			(endpoint.Path != "" && endpoint.Path != "/") || !ok || len(namespace) != 32 || !hex32(namespace) {
			return "", errCode("slice_endpoint_invalid")
		}
	}
	if account.Bucket != podhubTransitBucket {
		return "", errCode("slice_bucket_invalid")
	}
	prefix, err := normalizePrefix(account.KeyPrefix)
	if err != nil {
		return "", errCode("slice_bucket_invalid")
	}
	sum := sha256.Sum256([]byte("storage-bucket:v1\x00" + strings.TrimRight(account.Endpoint, "/") + "\x00" + account.Bucket + "\x00" + prefix))
	return hex.EncodeToString(sum[:]), nil
}

// normalizePrefix is "" or "a/b/".
func normalizePrefix(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." || strings.Contains(part, "\\") {
			return "", errCode("slice_bucket_invalid")
		}
	}
	return trimmed + "/", nil
}

// SelectTargets keeps the one transit account. A missing role, a duplicate
// bucket name or weak credentials refuse the whole set: an unclear target
// must never clear an unrelated bucket.
func SelectTargets(accounts []Account) ([]Account, error) {
	seen := map[string]struct{}{}
	var selected []Account
	for _, account := range accounts {
		if account.Role != "transit" {
			continue
		}
		if _, ok := seen[account.Bucket]; ok {
			return nil, errCode("slice_target_duplicate")
		}
		seen[account.Bucket] = struct{}{}
		if _, err := Fingerprint(account); err != nil {
			return nil, err
		}
		if account.Region != "auto" || !account.ForcePathStyle ||
			strings.TrimSpace(account.AccessKeyID) == "" || strings.TrimSpace(account.SecretAccessKey) == "" {
			return nil, errCode("slice_credentials_invalid")
		}
		account.KeyPrefix = ""
		selected = append(selected, account)
	}
	if len(selected) > 1 {
		return nil, errCode("slice_target_duplicate")
	}
	return selected, nil
}

func hex32(value string) bool {
	if len(value) != 32 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

type codeError string

func (e codeError) Error() string { return string(e) }

func errCode(code string) error { return codeError(code) }

// Code returns the stable error code when err came from this package.
func Code(err error) string {
	if err == nil {
		return ""
	}
	if coded, ok := err.(codeError); ok {
		return string(coded)
	}
	return ""
}
