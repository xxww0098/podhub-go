package domain

import (
	"sort"
	"strconv"
	"strings"

	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
)

const supplierPathShape = "对象路径必须是根目录内不含空段、.、..、反斜线或控制字符的相对路径"

// SupplierPath parses a storage-tree relative path.
// allowRoot accepts the empty list prefix.
func SupplierPath(raw string, allowRoot bool) (string, error) {
	if raw == "" {
		if allowRoot {
			return "", nil
		}
		return "", fail(contract.KindValidation, "对象路径不能为空")
	}
	if len(raw) > maxPathLen || strings.HasPrefix(raw, "/") || strings.Contains(raw, `\`) || hasUnicodeControl(raw) {
		return "", fail(contract.KindValidation, supplierPathShape)
	}
	if len(raw) >= 2 && raw[1] == ':' && isASCIILetter(raw[0]) {
		return "", fail(contract.KindValidation, supplierPathShape)
	}
	for _, part := range strings.Split(raw, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fail(contract.KindValidation, supplierPathShape)
		}
	}
	if IsReserved(raw) {
		return "", fail(contract.KindValidation, "该路径为上传暂存或确认事实保留路径")
	}
	return raw, nil
}

// SupplierCursor rejects an empty, over-long, or control-bearing token.
// A missing query value is not an error; an empty string is.
func SupplierCursor(cursor *string) error {
	if cursor == nil {
		return nil
	}
	if *cursor == "" || len(*cursor) > maxCursorLen || hasUnicodeControl(*cursor) {
		return fail(contract.KindValidation, "cursor 无效")
	}
	return nil
}

// StorageRoot normalizes the bucket key prefix. Illegal prefixes are internal.
func StorageRoot(prefix string) (string, error) {
	root, err := NormalizeKeyPrefix(prefix)
	if err != nil {
		return "", fail(contract.KindInternal, "服务暂不可用")
	}
	return root, nil
}

// StorageItem is one file or directory in declaration order.
type StorageItem struct {
	Path         string  `json:"path"`
	Kind         string  `json:"kind"`
	Bytes        int64   `json:"bytes"`
	LastModified *string `json:"lastModified,omitempty"`
	PublicURL    *string `json:"publicUrl,omitempty"`
}

// StoragePage is SupplierDbStorageObjectsData.
type StoragePage struct {
	Prefix     string        `json:"prefix"`
	Items      []StorageItem `json:"items"`
	NextCursor *string       `json:"nextCursor,omitempty"`
}

// ProjectStorage turns one ListObjectsV2 page into the admin view.
// root is the normalized key prefix. userPrefix is the query prefix.
// nextCursor is returned even when every object on the page is hidden.
func ProjectStorage(root, userPrefix, publicBase, xml string) StoragePage {
	s3Prefix := root
	if userPrefix != "" {
		s3Prefix = root + userPrefix + "/"
	}
	type row struct {
		item StorageItem
	}
	byPath := map[string]StorageItem{}
	for _, block := range splitTag(xml, "Contents") {
		key := unescapeXML(inner(block, "Key"))
		if key == "" || key == s3Prefix || IsReserved(key) {
			continue
		}
		if !strings.HasPrefix(key, root) {
			continue
		}
		rel := strings.TrimPrefix(key, root)
		size := int64(0)
		if raw := strings.TrimSpace(inner(block, "Size")); raw != "" {
			if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
				size = n
			}
		}
		item := StorageItem{Path: rel, Kind: "file", Bytes: size}
		if mod := unescapeXML(inner(block, "LastModified")); mod != "" {
			item.LastModified = &mod
		}
		url := sign.PublicURL(sign.Account{PublicBaseURL: publicBase}, key)
		item.PublicURL = &url
		byPath[rel] = item
	}
	for _, block := range splitTag(xml, "CommonPrefixes") {
		prefix := unescapeXML(inner(block, "Prefix"))
		if prefix == "" || IsReserved(prefix) || !strings.HasPrefix(prefix, root) {
			continue
		}
		rel := strings.TrimPrefix(prefix, root)
		rel = strings.TrimSuffix(rel, "/")
		if rel == "" {
			continue
		}
		byPath[rel] = StorageItem{Path: rel, Kind: "directory", Bytes: 0}
	}
	paths := make([]string, 0, len(byPath))
	for path := range byPath {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	items := make([]StorageItem, 0, len(paths))
	for _, path := range paths {
		items = append(items, byPath[path])
	}
	page := StoragePage{Prefix: userPrefix, Items: items}
	if strings.TrimSpace(firstInner(xml, "IsTruncated")) == "true" {
		token := unescapeXML(firstInner(xml, "NextContinuationToken"))
		if token != "" {
			page.NextCursor = &token
		}
	}
	return page
}

// DeleteTally is the delete response counters.
type DeleteTally struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Deleted   int    `json:"deleted"`
	Missing   int    `json:"missing"`
	Failed    int    `json:"failed"`
	Remaining bool   `json:"remaining"`
}

// Remaining is more || failed > 0.
func Remaining(more bool, failed int) bool { return more || failed > 0 }

// ListedKeys returns every object key on a list page, including reserved ones.
// next is the unescaped continuation token when the page is truncated.
func ListedKeys(xml string) (keys []string, next string, more bool) {
	for _, block := range splitTag(xml, "Contents") {
		key := unescapeXML(inner(block, "Key"))
		if key != "" {
			keys = append(keys, key)
		}
	}
	if strings.TrimSpace(firstInner(xml, "IsTruncated")) == "true" {
		more = true
		next = unescapeXML(firstInner(xml, "NextContinuationToken"))
	}
	return keys, next, more
}
