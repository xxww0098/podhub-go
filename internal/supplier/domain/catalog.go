package domain

import (
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

const (
	catalogStaleAgeMS int64 = 24 * 60 * 60 * 1000
	catalogMaxAgeMS   int64 = 72 * 60 * 60 * 1000
)

// Freshness is catalog_freshness. A missing fetched_at is Fresh at the call site.
func Freshness(fetchedAt, now int64) string {
	age := now - fetchedAt
	if fetchedAt > now {
		age = 0
	}
	if age > catalogMaxAgeMS {
		return "expired"
	}
	if age > catalogStaleAgeMS {
		return "stale"
	}
	return "fresh"
}

// ListabilityFacts are the inputs of product_listability.
// PromptValid is the caller's ocr_prompt::validate_brief result.
type ListabilityFacts struct {
	SourceListed    bool
	ProductArchived bool
	SKUPublished    bool
	PromptValid     bool
	ConfigState     string
	ValidatedDigest *string
	CurrentDigest   *string
	Freshness       string
}

// Denial is the first failing reason, or "" when the row is listable.
func Denial(f ListabilityFacts) string {
	switch {
	case !f.SourceListed:
		return "source_not_listed"
	case f.ProductArchived:
		return "product_archived"
	case !f.SKUPublished:
		return "sku_not_published"
	case f.Freshness == "expired":
		return "catalog_expired"
	case f.CurrentDigest == nil:
		return "catalog_missing"
	case f.ConfigState != "valid":
		return "config_needs_reconfiguration"
	case !sameDigest(f.ValidatedDigest, f.CurrentDigest):
		return "catalog_digest_mismatch"
	case !f.PromptValid:
		return "prompt_invalid"
	default:
		return ""
	}
}

func sameDigest(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// ConfigState maps the stored token. NULL and unknown are needs_reconfiguration.
func ConfigState(raw *string) string {
	if raw == nil {
		return "needs_reconfiguration"
	}
	switch *raw {
	case "valid":
		return "valid"
	case "needs_reconfiguration":
		return "needs_reconfiguration"
	default:
		return "needs_reconfiguration"
	}
}

// ParseSourceID is the catalog image source id: 1..=80 of [A-Za-z0-9_-].
func ParseSourceID(raw string) (string, error) {
	if n := len(raw); n < 1 || n > 80 {
		return "", contractImagePath()
	}
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == '_' || c == '-' || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			continue
		}
		return "", contractImagePath()
	}
	return raw, nil
}

// ParseImageFile returns the lowercase object id and the canonical extension.
func ParseImageFile(raw string) (id, ext string, err error) {
	dot := strings.LastIndex(raw, ".")
	if dot <= 0 || dot == len(raw)-1 {
		return "", "", contractImagePath()
	}
	id = raw[:dot]
	if len(id) != 64 {
		return "", "", contractImagePath()
	}
	for i := 0; i < len(id); i++ {
		if !isHex(id[i]) {
			return "", "", contractImagePath()
		}
	}
	switch raw[dot+1:] {
	case "jpg", "JPG":
		ext = "jpg"
	case "png", "PNG":
		ext = "png"
	case "webp", "WEBP":
		ext = "webp"
	default:
		return "", "", contractImagePath()
	}
	return strings.ToLower(id), ext, nil
}

// ParseEdge defaults to 640 and allows only 256, 640, 1280.
func ParseEdge(raw string, present bool) (uint32, error) {
	if !present || raw == "" {
		return 640, nil
	}
	switch raw {
	case "256":
		return 256, nil
	case "640":
		return 640, nil
	case "1280":
		return 1280, nil
	default:
		return 0, contract.Fail(400, "VALIDATION", "缩略图尺寸无效")
	}
}

func contractImagePath() error {
	return contract.Fail(400, "VALIDATION", "图片地址无效")
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// NormalizeKeyPrefix trims slashes and rejects empty segments, dot segments, and backslash.
func NormalizeKeyPrefix(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	if strings.Contains(trimmed, `\`) {
		return "", errPrefix()
	}
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", errPrefix()
		}
	}
	return trimmed + "/", nil
}

func errPrefix() error {
	return contract.Fail(500, "INTERNAL", "服务暂不可用")
}

// ContentTypeForExt is the original-byte type used when the image is not re-encoded.
func ContentTypeForExt(ext string) string {
	switch ext {
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	default:
		return "image/jpeg"
	}
}

// SafeInline reports image/* or application/pdf.
func SafeInline(mime string) bool {
	return strings.HasPrefix(mime, "image/") || mime == "application/pdf"
}

// WantsJSON is true when Accept has an application/json range whose q parses
// as a float and is greater than zero. A missing Accept, or only */*, is bytes.
func WantsJSON(accept string) bool {
	if strings.TrimSpace(accept) == "" {
		return false
	}
	for _, part := range strings.Split(accept, ",") {
		typ, params, _ := strings.Cut(part, ";")
		if !strings.EqualFold(strings.TrimSpace(typ), "application/json") {
			continue
		}
		ok := true
		for _, p := range strings.Split(params, ";") {
			name, value, has := strings.Cut(p, "=")
			if !has || !strings.EqualFold(strings.TrimSpace(name), "q") {
				continue
			}
			q, err := strconv.ParseFloat(strings.TrimSpace(value), 32)
			if err != nil || q <= 0 {
				ok = false
			}
		}
		if ok {
			return true
		}
	}
	return false
}
