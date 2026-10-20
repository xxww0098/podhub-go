// Package sign is the SigV4 presigner from src/media/upload/signing.rs and
// src/media/direct_upload.rs at a03d735.
//
// Browser PUT grants are produced here, not by aws-sdk-go-v2's presigner.
// The SDK adds its own checksum headers, so a PresignPutObject URL is not
// the canonical request Rust signs. List, delete, and head go through
// internal/storage and the SDK. This package only builds the URL.
package sigv4

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

const algorithm = "AWS4-HMAC-SHA256"

// PutTTL is the browser PUT lifetime.
const PutTTL = 600 * time.Second

// MaxObjectBytes is the single PUT cap (2 GiB).
const MaxObjectBytes uint64 = 2 * 1024 * 1024 * 1024

// Provider is the serde snake_case spelling of IntegrationMediaProvider.
type Provider string

const (
	ProviderCloudflare Provider = "cloudflare"
	ProviderGeneric    Provider = "generic"
	ProviderLegacyS3   Provider = "legacy_s3"
	ProviderQiniu      Provider = "qiniu"
	ProviderTencent    Provider = "tencent"
	ProviderAliyun     Provider = "aliyun"
)

// Account is the media account the signer needs. Secrets stay in this process.
type Account struct {
	ID              string
	Provider        Provider
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

// Grant is the browser PUT. ChecksumSHA256 is set only when the store accepts it.
type Grant struct {
	URL            string
	ContentType    string
	IfNoneMatch    string
	ChecksumSHA256 string
	ExpiresAt      time.Time
	Canonical      string
}

// Error carries a Rust-facing message.
type Error struct{ Message string }

func (e Error) Error() string { return e.Message }

func invalid(message string) error { return Error{Message: message} }

// PresignURL signs one S3-compatible URL. canonical is the string that was hashed.
// expires is in seconds. extraQuery and extraHeaders are covered by the signature.
func PresignURL(account Account, method, key string, contentType string, stamp time.Time, expires time.Duration, extraQuery [][2]string, extraHeaders [][2]string) (rawURL, canonical string, err error) {
	switch account.Provider {
	case ProviderLegacyS3, ProviderCloudflare, ProviderQiniu, ProviderTencent, ProviderAliyun, ProviderGeneric:
	default:
		return "", "", invalid("媒体账号 provider 不受支持")
	}
	endpoint, err := url.Parse(strings.TrimSpace(account.Endpoint))
	if err != nil {
		return "", "", invalid("媒体账号 endpoint 不是合法 URL")
	}
	hostName := endpoint.Hostname()
	if hostName == "" {
		return "", "", invalid("媒体账号 endpoint 缺少主机名")
	}
	port := ""
	if p := endpoint.Port(); p != "" {
		port = ":" + p
	}
	objectPath := ""
	if key != "" {
		objectPath = "/" + EncodeObjectPath(key)
	}
	var host, canonicalPath string
	if account.ForcePathStyle {
		host = hostName + port
		canonicalPath = "/" + EncodePathSegment(strings.TrimSpace(account.Bucket)) + objectPath
	} else {
		host = strings.TrimSpace(account.Bucket) + "." + hostName + port
		if objectPath == "" {
			canonicalPath = "/"
		} else {
			canonicalPath = objectPath
		}
	}
	day := stamp.UTC().Format("20060102")
	amzDate := stamp.UTC().Format("20060102T150405Z")
	credential := fmt.Sprintf("%s/%s/%s/s3/aws4_request", strings.TrimSpace(account.AccessKeyID), day, strings.TrimSpace(account.Region))
	query := [][2]string{
		{"X-Amz-Algorithm", algorithm},
		{"X-Amz-Credential", credential},
		{"X-Amz-Date", amzDate},
		{"X-Amz-Expires", fmt.Sprintf("%d", int64(expires/time.Second))},
	}
	if token := strings.TrimSpace(account.SessionToken); token != "" {
		query = append(query, [2]string{"X-Amz-Security-Token", token})
	}
	query = append(query, extraQuery...)
	headers := [][2]string{{"host", host}}
	if contentType != "" {
		headers = append(headers, [2]string{"content-type", contentType})
	}
	for _, header := range extraHeaders {
		headers = append(headers, [2]string{strings.ToLower(header[0]), header[1]})
	}
	sort.Slice(headers, func(i, j int) bool { return headers[i][0] < headers[j][0] })
	names := make([]string, len(headers))
	var canonicalHeaders strings.Builder
	for i, header := range headers {
		names[i] = header[0]
		canonicalHeaders.WriteString(header[0])
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(header[1])
		canonicalHeaders.WriteByte('\n')
	}
	signed := strings.Join(names, ";")
	query = append(query, [2]string{"X-Amz-SignedHeaders", signed})
	sort.Slice(query, func(i, j int) bool { return query[i][0] < query[j][0] })
	encoded := make([]string, len(query))
	for i, item := range query {
		encoded[i] = item[0] + "=" + queryEncode(item[1])
	}
	canonicalQuery := strings.Join(encoded, "&")
	canonical = fmt.Sprintf("%s\n%s\n%s\n%s\n%s\nUNSIGNED-PAYLOAD",
		method, canonicalPath, canonicalQuery, canonicalHeaders.String(), signed)
	scope := fmt.Sprintf("%s/%s/s3/aws4_request", day, strings.TrimSpace(account.Region))
	stringToSign := fmt.Sprintf("%s\n%s\n%s\n%s", algorithm, amzDate, scope, sha256Hex(canonical))
	derived := signingKey(strings.TrimSpace(account.SecretAccessKey), day, strings.TrimSpace(account.Region))
	signature := hex.EncodeToString(hmacSHA256(derived, []byte(stringToSign)))
	rawURL = fmt.Sprintf("%s://%s%s?%s&X-Amz-Signature=%s", endpoint.Scheme, host, canonicalPath, canonicalQuery, signature)
	return rawURL, canonical, nil
}

// SignPut signs a browser PUT. Checksum hex is included only when the store accepts it.
func SignPut(account Account, key, contentType string, byteLength uint64, now time.Time, checksumHex string, expiresAt *time.Time) (Grant, error) {
	if byteLength == 0 || byteLength > MaxObjectBytes || contentType == "" || len(contentType) > 128 || badHeader(contentType) {
		return Grant{}, invalid("上传大小或文件类型无效")
	}
	var checksum string
	if checksumHex != "" && AcceptsStoreChecksum(account) {
		encoded, ok := ChecksumB64(checksumHex)
		if !ok {
			return Grant{}, invalid("上传大小或文件类型无效")
		}
		checksum = encoded
	}
	ttl := PutTTL
	if expiresAt != nil {
		seconds := expiresAt.UTC().Unix() - now.UTC().Unix()
		if seconds > int64(PutTTL/time.Second) {
			seconds = int64(PutTTL / time.Second)
		}
		if seconds <= 0 {
			return Grant{}, invalid("上传目标有效期已过期")
		}
		ttl = time.Duration(seconds) * time.Second
	}
	signed := [][2]string{
		{"content-length", fmt.Sprintf("%d", byteLength)},
		{"if-none-match", "*"},
	}
	if checksum != "" {
		signed = append(signed, [2]string{"x-amz-checksum-sha256", checksum})
	}
	rawURL, canonical, err := PresignURL(account, "PUT", key, contentType, now, ttl, nil, signed)
	if err != nil {
		return Grant{}, err
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return Grant{}, invalid("上传地址配置无效")
	}
	local := parsed.Scheme == "http" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1")
	if parsed.Scheme != "https" && !local {
		return Grant{}, invalid("浏览器直传需要 HTTPS 对象存储地址")
	}
	return Grant{
		URL:            rawURL,
		ContentType:    contentType,
		IfNoneMatch:    "*",
		ChecksumSHA256: checksum,
		ExpiresAt:      now.UTC().Add(ttl),
		Canonical:      canonical,
	}, nil
}

// AcceptsStoreChecksum reports whether the supplier signs x-amz-checksum-sha256.
// Qiniu, Tencent COS and Aliyun never do. Generic and legacy_s3 do only on an
// official R2 or AWS S3 API host.
func AcceptsStoreChecksum(account Account) bool {
	switch account.Provider {
	case ProviderQiniu, ProviderTencent, ProviderAliyun:
		return false
	case ProviderCloudflare:
		return true
	case ProviderLegacyS3, ProviderGeneric:
		host, ok := endpointHost(account.Endpoint)
		return ok && (isR2APIHost(host) || isAWSS3APIHost(host))
	default:
		return false
	}
}

// ChecksumB64 encodes a 64-char hex SHA-256 as standard base64.
func ChecksumB64(sha256Hex string) (string, bool) {
	if len(sha256Hex) != 64 {
		return "", false
	}
	raw := make([]byte, 32)
	for i := 0; i < 32; i++ {
		value, err := hex.DecodeString(sha256Hex[i*2 : i*2+2])
		if err != nil {
			return "", false
		}
		raw[i] = value[0]
	}
	return base64.StdEncoding.EncodeToString(raw), true
}

// FullObjectSHA256 accepts a full-object checksum header. A "-N" suffix is multipart.
func FullObjectSHA256(header string) (string, bool) {
	header = strings.TrimSpace(header)
	if header == "" || strings.Contains(header, "-") {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil || len(raw) != 32 {
		return "", false
	}
	return hex.EncodeToString(raw), true
}

// PublicURL joins the account base and the encoded key.
func PublicURL(account Account, key string) string {
	base := strings.TrimRight(strings.TrimSpace(account.PublicBaseURL), "/")
	return base + "/" + EncodeObjectPath(key)
}

// EncodeObjectPath percent-encodes each segment and keeps '/'.
func EncodeObjectPath(value string) string {
	parts := strings.Split(value, "/")
	for i, part := range parts {
		parts[i] = EncodePathSegment(part)
	}
	return strings.Join(parts, "/")
}

// EncodePathSegment percent-encodes one segment, including '/'.
func EncodePathSegment(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if isUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func endpointHost(endpoint string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || parsed.Hostname() == "" {
		return "", false
	}
	return strings.ToLower(parsed.Hostname()), true
}

func isR2APIHost(host string) bool {
	rest, ok := strings.CutSuffix(host, ".r2.cloudflarestorage.com")
	if !ok {
		return false
	}
	labels := strings.Split(rest, ".")
	if labels[0] == "" {
		return false
	}
	switch len(labels) {
	case 1:
		return true
	case 2:
		return labels[1] == "eu" || labels[1] == "fedramp"
	default:
		return false
	}
}

func isAWSS3APIHost(host string) bool {
	china := false
	rest, ok := strings.CutSuffix(host, ".amazonaws.com.cn")
	if ok {
		china = true
	} else {
		rest, ok = strings.CutSuffix(host, ".amazonaws.com")
		if !ok {
			return false
		}
	}
	if !china && rest == "s3" {
		return true
	}
	labels := strings.Split(rest, ".")
	if len(labels) < 2 || (labels[0] != "s3" && labels[0] != "s3-fips") {
		return false
	}
	region := labels[1]
	next := 2
	if region == "dualstack" {
		if len(labels) < 3 {
			return false
		}
		region = labels[2]
		next = 3
	}
	return next == len(labels) && isAWSRegion(region)
}

func isAWSRegion(region string) bool {
	if region == "" || len(region) > 32 {
		return false
	}
	if region[0] < 'a' || region[0] > 'z' {
		return false
	}
	for i := 0; i < len(region); i++ {
		c := region[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
}

func badHeader(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 32 || value[i] == 127 {
			return true
		}
	}
	return false
}

func queryEncode(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if isUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func isUnreserved(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.' || b == '~'
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func signingKey(secret, day, region string) []byte {
	date := hmacSHA256([]byte("AWS4"+secret), []byte(day))
	regionKey := hmacSHA256(date, []byte(region))
	service := hmacSHA256(regionKey, []byte("s3"))
	return hmacSHA256(service, []byte("aws4_request"))
}

func hmacSHA256(key, value []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(value)
	return mac.Sum(nil)
}
