package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"

	mediacontract "github.com/xxww0098/podhub-go/internal/media/contract"
)

// BucketIn is one storage account from the replace body.
type BucketIn struct {
	ID         string
	Label      string
	Role       string
	Provider   string
	Endpoint   string
	Region     string
	Bucket     string
	KeyPrefix  string
	PublicBase string
	ForcePath  bool
	AccessKey  string
	SecretKey  string
	Session    string
	Active     bool
}

// Buckets validates the whole three-bucket configuration. There is no
// fallback roster and no partially valid set: every configured role must
// match its physical bucket and its exact public hostname.
func Buckets(rows []BucketIn) ([]mediacontract.Config, string) {
	if len(rows) > 3 {
		return nil, "存储最多配置三个桶"
	}
	seenRole := map[mediacontract.Role]bool{}
	seenIdentity := map[string]string{}
	out := make([]mediacontract.Config, 0, len(rows))
	for _, row := range rows {
		role, err := mediacontract.ParseRole(row.Role)
		if err != nil {
			return nil, "存储桶角色必须是 transit、assets 或 private"
		}
		if seenRole[role] {
			return nil, "同一个存储桶角色只能配置一个账号"
		}
		seenRole[role] = true
		if strings.TrimSpace(row.Label) == "" {
			return nil, "存储账号名称无效"
		}
		account := mediacontract.Config{
			Role: role, Provider: strings.TrimSpace(row.Provider),
			Endpoint: strings.TrimSpace(row.Endpoint), Region: strings.TrimSpace(row.Region),
			Bucket: strings.TrimSpace(row.Bucket), KeyPrefix: row.KeyPrefix,
			PublicBaseURL: strings.TrimSpace(row.PublicBase), ForcePathStyle: row.ForcePath,
			AccessKeyID: strings.TrimSpace(row.AccessKey), SecretAccessKey: strings.TrimSpace(row.SecretKey),
			SessionToken: row.Session,
		}
		if err := account.Validate(); err != nil {
			return nil, bucketMessage(err)
		}
		identity, err := account.Identity()
		if err != nil {
			return nil, "存储桶身份不完整"
		}
		if other, ok := seenIdentity[identity]; ok {
			return nil, "存储桶 " + other + " 与 " + string(role) + " 共用同一个物理桶"
		}
		seenIdentity[identity] = string(role)
		out = append(out, account)
	}
	return out, ""
}

// bucketMessage is the operator-facing sentence for a role rule.
func bucketMessage(err error) string {
	switch err {
	case mediacontract.ErrRole:
		return "存储桶角色无效"
	case mediacontract.ErrBucket:
		return "物理桶名必须与角色一致：transit 用 podhub-transit，assets 用 podhub-assets，private 用 podhub-private"
	case mediacontract.ErrPublicHost:
		return "公开域名必须与角色一致：transit 只能是 https://transit.podhub.si，assets 只能是 https://assets.podhub.si，private 必须留空"
	case mediacontract.ErrProvider:
		return "存储 provider 只支持 cloudflare"
	case mediacontract.ErrEndpoint:
		return "存储端点必须是 *.r2.cloudflarestorage.com、auto 区域与路径式访问"
	case mediacontract.ErrIdentity:
		return "存储连接配置不完整"
	case mediacontract.ErrKey:
		return "存储路径前缀无效"
	default:
		return "存储连接配置无效"
	}
}

// BucketFingerprint is the physical bucket identity a purge receipt is keyed
// by. It is the same digest stored on registry rows, so renaming an account
// never resets the daily continuity.
func BucketFingerprint(row mediacontract.Config) (string, bool) {
	identity, err := row.Identity()
	if err != nil {
		return "", false
	}
	return identity, true
}

// PublicHostOf is the exact host the browser must see for a role.
func PublicHostOf(role mediacontract.Role) string { return mediacontract.PublicHost(role) }

// StorageURL joins the exact public host and the key. Keys already carry the
// prefix; it is never added twice.
func StorageURL(role mediacontract.Role, key string) string {
	return mediacontract.PublicURL(role, key)
}

// endpointHost is the lowercase host of an endpoint URL.
func endpointHost(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

// EndpointDigest is the physical identity digest used by the purge receipts.
func EndpointDigest(endpoint, bucket string) string {
	sum := sha256.Sum256([]byte(strings.TrimRight(strings.TrimSpace(endpoint), "/") + "\x00" + strings.TrimSpace(bucket)))
	return hex.EncodeToString(sum[:])
}
