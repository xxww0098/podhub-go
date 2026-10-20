package domain

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode"
)

const (
	maxPathLen   = 1024
	maxCursorLen = 4096
	maxGroups    = 100
	schemaV1     = 1
	configAAD    = "platform_integration_config|v1"
	exampleKey   = "set-a-random-32-plus-character-server-secret"
)

var (
	ErrPrefix       = errors.New("媒体路径前缀无效")
	ErrPathEmpty    = errors.New("对象路径不能为空")
	ErrPathShape    = errors.New("对象路径必须是账号根目录内不含空段、.、..、反斜线或控制字符的相对路径")
	ErrReserved     = errors.New("该路径为上传暂存或确认事实保留路径")
	ErrPathLong     = errors.New("对象路径过长")
	ErrCursor       = errors.New("cursor 无效")
	ErrPrefixInside = errors.New("对象前缀必须位于账号前缀之内")
	ErrPrefixBad    = errors.New("对象前缀无效")
	ErrContentType  = errors.New("contentType 无效")
	ErrKeyMissing   = errors.New("平台连接配置密钥未设置")
	ErrKeyExample   = errors.New("平台连接配置密钥不能使用 .env.example 中的占位值")
	ErrSnapshot     = errors.New("snapshot")
	ErrSchema       = errors.New("已存储的连接配置 schema 版本不受支持")
	ErrNoConfig     = errors.New("平台尚未配置媒体存储")
	ErrAccount      = errors.New("媒体存储账号不存在")
	ErrTransit      = errors.New("中转桶每天清空，不能写入长期对象")
	ErrStageDir     = errors.New("该路径为上传暂存保留目录")
)

// CloudAccount is one decrypted storageBuckets row.
type CloudAccount struct {
	ID              string
	Role            string
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
	Active          bool
}

// NormalizeKeyPrefix trims slashes and rejects empty segments, . and ...
func NormalizeKeyPrefix(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	if strings.Contains(trimmed, "\\") {
		return "", ErrPrefix
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrPrefix
		}
	}
	return trimmed + "/", nil
}

// RelativePath parses a request path. allowRoot accepts the empty root.
func RelativePath(raw string, allowRoot bool) (string, error) {
	if raw == "" {
		if allowRoot {
			return "", nil
		}
		return "", ErrPathEmpty
	}
	if len(raw) > maxPathLen || strings.HasPrefix(raw, "/") || strings.Contains(raw, "\\") || hasUnicodeControl(raw) {
		return "", ErrPathShape
	}
	if len(raw) >= 2 && raw[1] == ':' && isASCIILetter(raw[0]) {
		return "", ErrPathShape
	}
	for _, part := range strings.Split(raw, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrPathShape
		}
	}
	if IsReserved(raw) {
		return "", ErrReserved
	}
	return raw, nil
}

// HasDirectUploadSegment is the narrower presign check: a segment equal to
// .direct-uploads. A trailing .verified name is not this check.
func HasDirectUploadSegment(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == ".direct-uploads" {
			return true
		}
	}
	return false
}

// IsReserved is true when any segment is .direct-uploads or ends with .verified.
func IsReserved(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == ".direct-uploads" || strings.HasSuffix(part, ".verified") {
			return true
		}
	}
	return false
}

// ObjectKey joins root and path, then rejects reserved or over-long keys.
func ObjectKey(root, rel string) (string, error) {
	key := root + rel
	if IsReserved(key) || (rel != "" && IsReserved(rel)) {
		return "", ErrReserved
	}
	if len(key) > maxPathLen {
		return "", ErrPathLong
	}
	return key, nil
}

// DirectoryPrefix is root, or key plus a trailing slash.
func DirectoryPrefix(root, rel string) (string, error) {
	if rel == "" {
		return root, nil
	}
	key, err := ObjectKey(root, rel)
	if err != nil {
		return "", err
	}
	if len(key) == maxPathLen {
		return "", ErrPathLong
	}
	return key + "/", nil
}

// ParseMediaCursor rejects an empty, over-long, or control-bearing token.
func ParseMediaCursor(cursor *string) error {
	if cursor == nil {
		return nil
	}
	if *cursor == "" || len(*cursor) > maxCursorLen || hasUnicodeControl(*cursor) {
		return ErrCursor
	}
	return nil
}

// NormalizeListPrefix folds a requested prefix onto the account root.
func NormalizeListPrefix(root, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if IsReserved(root) || (requested != "" && IsReserved(requested)) {
		return "", ErrReserved
	}
	if requested == "" {
		return root, nil
	}
	if len(requested) > maxPathLen || strings.Contains(requested, "..") || strings.HasPrefix(requested, "/") {
		return "", ErrPrefixBad
	}
	if !strings.HasPrefix(requested, root) {
		return "", ErrPrefixInside
	}
	return requested, nil
}

// ContentType rejects empty, padded, over-long, or header-illegal types.
func ContentType(raw string) error {
	if raw == "" || len(raw) > 128 || strings.TrimSpace(raw) != raw || !headerOK(raw) {
		return ErrContentType
	}
	return nil
}

func headerOK(value string) bool {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c <= 0x20 || c >= 0x7f || c == '"' || c == '\\' {
			return false
		}
	}
	return true
}

// OpenSnapshot decrypts a platform_integration_config row.
// The key is SHA-256 of the trimmed secret. A legacy row without AAD is tried second.
func OpenSnapshot(secret string, nonce, ciphertext []byte) ([]CloudAccount, error) {
	secret = strings.TrimSpace(secret)
	if len(secret) < 32 {
		return nil, ErrKeyMissing
	}
	if secret == exampleKey {
		return nil, ErrKeyExample
	}
	if len(nonce) != 12 {
		return nil, ErrSnapshot
	}
	sum := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, ErrSnapshot
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrSnapshot
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, []byte(configAAD))
	if err != nil {
		plain, err = gcm.Open(nil, nonce, ciphertext, nil)
		if err != nil {
			return nil, ErrSnapshot
		}
	}
	return parseSnapshot(plain)
}

type storedSnapshot struct {
	SchemaVersion int           `json:"schemaVersion"`
	Buckets       []storedMedia `json:"storageBuckets"`
}

type storedMedia struct {
	ID              string  `json:"id"`
	Role            string  `json:"role"`
	Provider        *string `json:"provider"`
	Endpoint        string  `json:"endpoint"`
	Region          string  `json:"region"`
	Bucket          string  `json:"bucket"`
	KeyPrefix       string  `json:"keyPrefix"`
	PublicBaseURL   string  `json:"publicBaseUrl"`
	ForcePathStyle  bool    `json:"forcePathStyle"`
	AccessKeyID     string  `json:"accessKeyId"`
	SecretAccessKey string  `json:"secretAccessKey"`
	SessionToken    string  `json:"sessionToken"`
	Active          bool    `json:"active"`
}

func parseSnapshot(plain []byte) ([]CloudAccount, error) {
	var snap storedSnapshot
	if err := json.Unmarshal(plain, &snap); err != nil {
		return nil, ErrSnapshot
	}
	if snap.SchemaVersion != schemaV1 {
		return nil, ErrSchema
	}
	out := make([]CloudAccount, 0, len(snap.Buckets))
	for _, row := range snap.Buckets {
		provider := "legacy_s3"
		if row.Provider != nil && *row.Provider != "" {
			provider = *row.Provider
		}
		out = append(out, CloudAccount{
			ID: row.ID, Role: row.Role, Provider: provider, Endpoint: row.Endpoint, Region: row.Region,
			Bucket: row.Bucket, KeyPrefix: row.KeyPrefix, PublicBaseURL: row.PublicBaseURL,
			ForcePathStyle: row.ForcePathStyle, AccessKeyID: row.AccessKeyID,
			SecretAccessKey: row.SecretAccessKey, SessionToken: row.SessionToken, Active: row.Active,
		})
	}
	return out, nil
}

// ResolveAccount picks one account. id nil picks the single active bucket.
// An empty roster, or a bucket with no active row, is ErrNoConfig.
func ResolveAccount(accounts []CloudAccount, id *string) (CloudAccount, error) {
	if id != nil {
		want := strings.TrimSpace(*id)
		for _, account := range accounts {
			if account.ID == want {
				return account, nil
			}
		}
		return CloudAccount{}, ErrAccount
	}
	for _, account := range accounts {
		if account.Active {
			return account, nil
		}
	}
	return CloudAccount{}, ErrNoConfig
}

// RequirePersistent rejects the daily-cleared transit bucket: a long-lived
// object written there would disappear at 04:00.
func RequirePersistent(account CloudAccount) error {
	if strings.TrimSpace(account.Role) == "transit" {
		return ErrTransit
	}
	return nil
}

// ListedObject is one Contents row.
type ListedObject struct {
	Key          string
	Size         int64
	LastModified string
}

// ListPage is one ListObjectsV2 page after the string split parser.
type ListPage struct {
	Contents  []ListedObject
	Prefixes  []string
	Truncated bool
	NextToken string
}

// ParseListPage splits ListObjectsV2 XML without a DOM.
func ParseListPage(xml string) ListPage {
	var page ListPage
	for _, block := range splitTag(xml, "Contents") {
		key := unescapeXML(inner(block, "Key"))
		if key == "" || !strings.Contains(block, "<Size>") {
			continue
		}
		size := int64(0)
		raw := strings.TrimSpace(inner(block, "Size"))
		if n, ok := parseI64(raw); ok {
			size = n
		}
		page.Contents = append(page.Contents, ListedObject{
			Key: key, Size: size, LastModified: inner(block, "LastModified"),
		})
	}
	for _, block := range splitTag(xml, "CommonPrefixes") {
		prefix := unescapeXML(inner(block, "Prefix"))
		if prefix != "" {
			page.Prefixes = append(page.Prefixes, prefix)
		}
	}
	truncated := strings.TrimSpace(firstInner(xml, "IsTruncated"))
	if truncated == "true" {
		page.Truncated = true
		page.NextToken = unescapeXML(firstInner(xml, "NextContinuationToken"))
	}
	return page
}

func splitTag(xml, tag string) []string {
	open := "<" + tag + ">"
	close := "</" + tag + ">"
	var out []string
	rest := xml
	for {
		i := strings.Index(rest, open)
		if i < 0 {
			return out
		}
		rest = rest[i+len(open):]
		j := strings.Index(rest, close)
		if j < 0 {
			return out
		}
		out = append(out, rest[:j])
		rest = rest[j+len(close):]
	}
}

func inner(block, tag string) string {
	return firstInner(block, tag)
}

func firstInner(xml, tag string) string {
	open := "<" + tag + ">"
	i := strings.Index(xml, open)
	if i < 0 {
		return ""
	}
	rest := xml[i+len(open):]
	j := strings.Index(rest, "</"+tag+">")
	if j < 0 {
		return ""
	}
	return rest[:j]
}

func unescapeXML(s string) string {
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&apos;", "'")
	s = strings.ReplaceAll(s, "&amp;", "&")
	return s
}

func parseI64(raw string) (int64, bool) {
	if raw == "" {
		return 0, false
	}
	var n int64
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int64(r-'0')
	}
	return n, true
}

// Group is one storage usage bucket.
type Group struct {
	Prefix        string
	WorkspaceName string
	Objects       int64
	Bytes         int64
	UUID          string
}

// GroupRows folds object keys into at most 100 groups.
// Totals count every scanned object, including those dropped from the group list.
func GroupRows(root string, objects []ListedObject) (groups []Group, objectsN, bytes int64, truncated bool) {
	type acc struct {
		name    string
		objects int64
		bytes   int64
	}
	order := []string{}
	by := map[string]*acc{}
	add := func(prefix, name string, size int64) {
		row, ok := by[prefix]
		if !ok {
			row = &acc{name: name}
			by[prefix] = row
			order = append(order, prefix)
		}
		row.objects++
		row.bytes += size
	}
	for _, object := range objects {
		objectsN++
		bytes += object.Size
		rest := object.Key
		if strings.HasPrefix(object.Key, root) {
			rest = strings.TrimPrefix(object.Key, root)
		}
		parts := strings.Split(rest, "/")
		switch {
		case len(parts) >= 3 && (parts[0] == "images" || parts[0] == "videos") && (parts[1] == "teams" || parts[1] == "workspaces") && parts[2] != "":
			add(root+parts[0]+"/"+parts[1]+"/"+parts[2]+"/", "", object.Size)
		case len(parts) >= 2 && (parts[0] == "teams" || parts[0] == "workspaces") && parts[1] != "":
			add(root+parts[0]+"/"+parts[1]+"/", "", object.Size)
		default:
			add(root+"(其他)", "其他", object.Size)
		}
	}
	groups = make([]Group, 0, len(order))
	for _, prefix := range order {
		row := by[prefix]
		groups = append(groups, Group{
			Prefix: prefix, WorkspaceName: row.name, Objects: row.objects, Bytes: row.bytes,
			UUID: workspaceUUID(root, prefix),
		})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Bytes != groups[j].Bytes {
			return groups[i].Bytes > groups[j].Bytes
		}
		return groups[i].Prefix < groups[j].Prefix
	})
	if len(groups) > maxGroups {
		truncated = true
		groups = groups[:maxGroups]
	}
	return groups, objectsN, bytes, truncated
}

func workspaceUUID(root, prefix string) string {
	rest := strings.TrimPrefix(prefix, root)
	rest = strings.TrimSuffix(rest, "/")
	for _, head := range []string{"images/teams/", "videos/teams/", "images/workspaces/", "videos/workspaces/", "teams/", "workspaces/"} {
		if id, ok := strings.CutPrefix(rest, head); ok && !strings.Contains(id, "/") && uuidV4(id) {
			return strings.ToLower(id)
		}
	}
	return ""
}

func uuidV4(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, c := range value {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		case 14:
			if c != '4' {
				return false
			}
		default:
			if !isHex(byte(c)) {
				return false
			}
		}
	}
	return true
}

func hasUnicodeControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func isASCIILetter(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
}

// SealSnapshot encrypts a snapshot for tests. AAD matches OpenSnapshot.
func SealSnapshot(secret string, nonce []byte, plain []byte) ([]byte, error) {
	sum := sha256.Sum256([]byte(strings.TrimSpace(secret)))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, ErrSnapshot
	}
	return gcm.Seal(nil, nonce, plain, []byte(configAAD)), nil
}
