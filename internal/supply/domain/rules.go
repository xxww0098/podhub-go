package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

// OrderEdges are the transitions the supply spec names.
// This HTTP package only inserts awaiting_payment. The later edges are written
// by payment and procurement handlers that are outside these ten routes.
// Illegal pairs are absent from this list.
var OrderEdges = []struct {
	From string
	To   string
	Name string
}{
	{From: "", To: "awaiting_payment", Name: "confirm_order"},
	{From: "awaiting_payment", To: "awaiting_procurement", Name: "mark_paid"},
	{From: "awaiting_procurement", To: "processing", Name: "procurement_claim"},
	{From: "processing", To: "in_production", Name: "procurement_dispatch"},
	{From: "in_production", To: "shipped", Name: "procurement_receipt_accepted"},
}

// LegalOrderEdge reports whether the pair is one of the named edges.
func LegalOrderEdge(from, to string) (string, bool) {
	for _, edge := range OrderEdges {
		if edge.From == from && edge.To == to {
			return edge.Name, true
		}
	}
	return "", false
}

// RequestHash is SHA-256 over each part followed by a NUL byte, lowercase hex.
func RequestHash(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = h.Write([]byte(part))
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// MintID is prefix plus a UUID with the hyphens removed.
func MintID(prefix string) string {
	return prefix + "_" + strings.ReplaceAll(uuid.NewString(), "-", "")
}

// ParseListingID trims and parses a UUID. Failure is the not-found sentence.
func ParseListingID(raw string) (string, error) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", contract.Fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	return id.String(), nil
}

// IdempotencyKey trims and requires 1..=64 Unicode scalars.
func IdempotencyKey(raw string) (string, error) {
	key := strings.TrimSpace(raw)
	n := len([]rune(key))
	if n < 1 || n > 64 {
		return "", contract.Fail(400, "VALIDATION", "幂等键须为 1–64 个字符")
	}
	return key, nil
}

// Quantity is the quote bound 1..=999.
func Quantity(n int64) error {
	if n < 1 || n > 999 {
		return contract.Fail(400, "VALIDATION", "数量须为 1–999")
	}
	return nil
}

// Placeholder requires a positive quantity. The HTTP default of 1 is applied
// before this check when the field is absent.
func Placeholder(n int64) error {
	if n < 1 {
		return contract.Fail(400, "VALIDATION", "数量占位必须大于 0")
	}
	return nil
}

// SKURequired rejects a blank platform sku.
func SKURequired(raw string) (string, error) {
	id := strings.TrimSpace(raw)
	if id == "" {
		return "", contract.Fail(400, "VALIDATION", "请选择平台 SKU")
	}
	return id, nil
}

// ProductionFile is one binding file after validation.
type ProductionFile struct {
	MediaAssetID string
	ContentHash  string
	HasHash      bool
}

const maxProductionFiles = 20

// ValidateFiles checks the binding file list. An empty list is allowed.
func ValidateFiles(files []ProductionFile) error {
	if len(files) > maxProductionFiles {
		return contract.Fail(400, "VALIDATION", "生产文件最多 20 项")
	}
	for _, file := range files {
		id := strings.TrimSpace(file.MediaAssetID)
		if GalleryLocal(id) {
			return contract.Fail(400, "VALIDATION", "生产文件必须是 Cloud Media Library 引用，不能使用图库本地路径")
		}
		if _, err := uuid.Parse(id); err != nil {
			return contract.Fail(400, "VALIDATION", "生产文件必须是 Cloud Media Library 素材 id")
		}
		if file.HasHash && !ValidContentHash(file.ContentHash) {
			return contract.Fail(400, "VALIDATION", "生产文件哈希须为 sha256: 加 64 位十六进制")
		}
	}
	return nil
}

// ValidContentHash is the literal prefix sha256: plus 64 ASCII hex digits.
func ValidContentHash(raw string) bool {
	const prefix = "sha256:"
	if !strings.HasPrefix(raw, prefix) || len(raw) != len(prefix)+64 {
		return false
	}
	for i := len(prefix); i < len(raw); i++ {
		c := raw[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// GalleryLocal is the path-shaped media id the binder rejects.
func GalleryLocal(raw string) bool {
	s := strings.TrimSpace(raw)
	if s == "" {
		return false
	}
	low := strings.ToLower(s)
	if strings.HasPrefix(low, "file:") || strings.HasPrefix(low, "blob:") {
		return true
	}
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, `\`) || strings.Contains(s, `\`) {
		return true
	}
	if len(s) >= 3 && unicode.IsLetter(rune(s[0])) && s[1] == ':' && (s[2] == '\\' || s[2] == '/') {
		return true
	}
	return false
}

// HasMaterial is the confirm-order gate: at least one trimmed media id.
func HasMaterial(files []ProductionFile) bool {
	for _, file := range files {
		if strings.TrimSpace(file.MediaAssetID) != "" {
			return true
		}
	}
	return false
}

// QuoteExpired is expires_at_ms <= now.
func QuoteExpired(expiresAt, now int64) bool { return expiresAt <= now }

// SellerStatus is the five literals GET and confirm may return.
// Any other stored word is an internal failure, not a new state.
func SellerStatus(raw string) (string, error) {
	switch raw {
	case "awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped":
		return raw, nil
	default:
		return "", contract.Fail(500, "INTERNAL", "服务暂不可用")
	}
}
