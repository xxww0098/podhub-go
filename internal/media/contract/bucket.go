// Package contract is the bucket model from docs/architecture/storage-common.md.
//
// Three physical buckets carry three roles: transit is the daily-cleared
// wasm delivery target, assets is the public long-lived library, and private
// is the org-owned long-lived store. A bucket role decides the public
// hostname, the accepted key shape, the dedupe scope and whether the object
// registry applies. This package is pure: no clock, no I/O, no provider SDK.
package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// Role is the fixed bucket role. It is not a free-form label.
type Role string

const (
	// RoleTransit is the short-lived wasm delivery bucket.
	RoleTransit Role = "transit"
	// RoleAssets is the public long-lived asset library.
	RoleAssets Role = "assets"
	// RolePrivate is the org-owned long-lived bucket. It has no public host.
	RolePrivate Role = "private"
)

var (
	// ErrRole is an unknown bucket role.
	ErrRole = errors.New("存储桶角色无效")
	// ErrBucket is a physical bucket name that does not match the role.
	ErrBucket = errors.New("存储桶名称与角色不符")
	// ErrPublicHost is a public hostname that is not the role's exact host.
	ErrPublicHost = errors.New("存储桶公开域名与角色不符")
	// ErrProvider is a provider other than the single supported one.
	ErrProvider = errors.New("对象存储 provider 只支持 cloudflare")
	// ErrEndpoint is an endpoint that is not the R2 API host.
	ErrEndpoint = errors.New("对象存储 endpoint 必须是 *.r2.cloudflarestorage.com")
	// ErrIdentity is an incomplete bucket identity.
	ErrIdentity = errors.New("存储桶身份不完整")
	// ErrScope is a dedupe scope that does not belong to the bucket role.
	ErrScope = errors.New("去重范围与存储桶角色不符")
	// ErrKey is a key that does not match the role's path shape.
	ErrKey = errors.New("对象路径与存储桶角色不符")
	// ErrExtension is an extension the public buckets refuse.
	ErrExtension = errors.New("对象扩展名不受支持")
	// ErrPurpose is an unknown upload purpose.
	ErrPurpose = errors.New("上传用途无效")
)

// Physical bucket names. One role, one bucket, one host.
const (
	BucketTransit = "podhub-transit"
	BucketAssets  = "podhub-assets"
	BucketPrivate = "podhub-private"
)

// Public hostnames. These are exact values, not patterns.
const (
	PublicHostTransit = "https://transit.podhub.si"
	PublicHostAssets  = "https://assets.podhub.si"
)

// r2APIHostSuffix is the only production egress target.
const r2APIHostSuffix = ".r2.cloudflarestorage.com"

// AllRoles is the closed set, in delivery order.
var AllRoles = []Role{RoleTransit, RoleAssets, RolePrivate}

// BucketName is the physical bucket for a role; "" for an unknown role.
func BucketName(role Role) string {
	switch role {
	case RoleTransit:
		return BucketTransit
	case RoleAssets:
		return BucketAssets
	case RolePrivate:
		return BucketPrivate
	default:
		return ""
	}
}

// PublicHost is the exact public hostname for a role; "" when the bucket is
// not public. The caller appends the encoded key directly: keys already carry
// the environment prefix, so the URL is {host}/{key} and never {host}/{prefix}/{key}.
func PublicHost(role Role) string {
	switch role {
	case RoleTransit:
		return PublicHostTransit
	case RoleAssets:
		return PublicHostAssets
	default:
		return ""
	}
}

// Public reports whether the role serves objects over a public hostname.
func Public(role Role) bool { return PublicHost(role) != "" }

// Registered reports whether objects of this role belong in storage_objects.
// Transit objects live for one day and carry no business reference.
func Registered(role Role) bool { return role == RoleAssets || role == RolePrivate }

// Config is one decrypted bucket account.
type Config struct {
	Role            Role
	Provider        string
	Endpoint        string
	Region          string
	Bucket          string
	KeyPrefix       string
	PublicBaseURL   string
	ForcePathStyle  bool
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// Identity is the physical bucket identity: endpoint + bucket + prefix.
// It is stored on every registry row and must never change while objects
// exist. The digest is stable and contains no credential.
func (c Config) Identity() (string, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(c.Endpoint), "/")
	bucket := strings.TrimSpace(c.Bucket)
	if endpoint == "" || bucket == "" {
		return "", ErrIdentity
	}
	prefix, err := NormalizePrefix(c.KeyPrefix)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte("storage-bucket:v1\x00" + endpoint + "\x00" + bucket + "\x00" + prefix))
	return hex.EncodeToString(sum[:]), nil
}

// NormalizePrefix is "" or "a/b/". Empty segments, "." and ".." are refused.
func NormalizePrefix(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	if strings.Contains(trimmed, `\`) {
		return "", ErrKey
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrKey
		}
	}
	return trimmed + "/", nil
}

// ParseRole reads the role name written in the integration snapshot.
func ParseRole(raw string) (Role, error) {
	role := Role(strings.TrimSpace(raw))
	switch role {
	case RoleTransit, RoleAssets, RolePrivate:
		return role, nil
	default:
		return "", ErrRole
	}
}
